// Tests for the adapter's directory prefetch cache.
//
// just-bash's find/grep walk the tree with one readdirWithFileTypes per
// directory. Against the workspace stub each is an RPC, so a recursive
// command over a tree containing node_modules costs thousands of round
// trips. The adapter can serve that walk from a single subtree read.
//
// The cache is only safe if it can never return stale data, so the
// invalidation contract is tested as carefully as the speedup.

import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "../../backend.js";
import { WorkspaceFilesystemStub } from "../../stub.js";
import { Workspace } from "../../workspace.js";
import { WorkspaceFsAdapter } from "./adapter.js";

function noopBackend(): WorkspaceBackend {
  return {
    id: "noop",
    async connect(): Promise<BackendHandle> {
      return {
        rpc: { sync: {} as never, shell: {} as never },
        sync: "none",
        close: async () => {},
      };
    },
  };
}

let workspace: Workspace;
let stub: WorkspaceFilesystemStub;
let adapter: WorkspaceFsAdapter;

beforeEach(async () => {
  workspace = new Workspace({
    storage: new SQLiteTestStorage() as never,
    backends: [noopBackend()],
  });
  await workspace.ready();
  stub = new WorkspaceFilesystemStub(workspace);
  adapter = new WorkspaceFsAdapter(stub);
});

afterEach(async () => {
  await workspace.close();
});

async function seedTree(): Promise<void> {
  for (let p = 0; p < 12; p++) {
    await workspace.fs.mkdir(`/node_modules/pkg-${p}/dist`, { recursive: true });
    await workspace.fs.writeFile(`/node_modules/pkg-${p}/package.json`, "{}\n");
    await workspace.fs.writeFile(`/node_modules/pkg-${p}/dist/index.js`, "vendor\n");
  }
  await workspace.fs.mkdir("/src/deep", { recursive: true });
  await workspace.fs.writeFile("/src/app.ts", "source\n");
  await workspace.fs.writeFile("/src/deep/mod.ts", "deep\n");
}

describe("directory prefetch", () => {
  it("serves a recursive walk from a single underlying call", async () => {
    await seedTree();
    const readdir = vi.spyOn(stub, "readdir");
    const find = vi.spyOn(stub, "find");

    adapter.beginPrefetch("/");
    try {
      // Walk the whole tree the way just-bash's find does.
      const seen: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await adapter.readdirWithFileTypes(dir)) {
          const child = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
          seen.push(child);
          if (entry.isDirectory) await walk(child);
        }
      };
      await walk("/");
      expect(seen).toContain("/src/app.ts");
      expect(seen).toContain("/node_modules/pkg-0/dist/index.js");
    } finally {
      adapter.endPrefetch();
    }

    // One subtree read replaces the per-directory listings.
    expect(find).toHaveBeenCalledTimes(1);
    expect(readdir).not.toHaveBeenCalled();
  });

  it("returns exactly what readdirWithFileTypes returns uncached", async () => {
    await seedTree();
    const uncached = await adapter.readdirWithFileTypes("/src");

    adapter.beginPrefetch("/");
    const cached = await adapter.readdirWithFileTypes("/src");
    adapter.endPrefetch();

    const sort = (xs: Array<{ name: string }>) =>
      [...xs].sort((a, b) => a.name.localeCompare(b.name));
    expect(sort(cached)).toEqual(sort(uncached));
  });

  it("reports directories, files and symlinks with the same flags", async () => {
    await workspace.fs.mkdir("/d/sub", { recursive: true });
    await workspace.fs.writeFile("/d/file.txt", "x");
    await workspace.fs.symlink("/d/file.txt", "/d/link");

    const uncached = await adapter.readdirWithFileTypes("/d");
    adapter.beginPrefetch("/");
    const cached = await adapter.readdirWithFileTypes("/d");
    adapter.endPrefetch();

    const byName = (xs: Array<{ name: string }>) => Object.fromEntries(xs.map((e) => [e.name, e]));
    expect(byName(cached)).toEqual(byName(uncached));
  });

  it("does not cache across prefetch scopes", async () => {
    await workspace.fs.writeFile("/a.txt", "one");
    adapter.beginPrefetch("/");
    expect((await adapter.readdirWithFileTypes("/")).map((e) => e.name)).toEqual(["a.txt"]);
    adapter.endPrefetch();

    // A write between scopes must be visible in the next scope.
    await workspace.fs.writeFile("/b.txt", "two");
    adapter.beginPrefetch("/");
    const names = (await adapter.readdirWithFileTypes("/")).map((e) => e.name).sort();
    adapter.endPrefetch();
    expect(names).toEqual(["a.txt", "b.txt"]);
  });

  it("invalidates the cache when a write happens inside the scope", async () => {
    await workspace.fs.writeFile("/a.txt", "one");
    adapter.beginPrefetch("/");
    try {
      expect((await adapter.readdirWithFileTypes("/")).map((e) => e.name)).toEqual(["a.txt"]);
      // A mutation through the adapter must drop the cached listing so
      // the next read observes it.
      await adapter.writeFile("/b.txt", "two");
      const names = (await adapter.readdirWithFileTypes("/")).map((e) => e.name).sort();
      expect(names).toEqual(["a.txt", "b.txt"]);
    } finally {
      adapter.endPrefetch();
    }
  });

  it("does not restore an in-flight snapshot after a write", async () => {
    await workspace.fs.writeFile("/a.txt", "one");
    const originalFind = stub.find.bind(stub);
    let releaseFind: (() => void) | undefined;
    const findGate = new Promise<void>((resolve) => {
      releaseFind = resolve;
    });
    const find = vi.spyOn(stub, "find").mockImplementation(async (...args) => {
      const snapshot = await originalFind(...args);
      await findGate;
      return snapshot;
    });

    adapter.beginPrefetch("/");
    try {
      const firstRead = adapter.readdirWithFileTypes("/");
      await vi.waitFor(() => expect(find).toHaveBeenCalledTimes(1));
      await adapter.writeFile("/b.txt", "two");
      releaseFind?.();
      await firstRead;

      const names = (await adapter.readdirWithFileTypes("/")).map((e) => e.name).sort();
      expect(names).toEqual(["a.txt", "b.txt"]);
      expect(find).toHaveBeenCalledTimes(2);
    } finally {
      releaseFind?.();
      adapter.endPrefetch();
    }
  });

  it("invalidates on rm, mkdir and symlink too", async () => {
    await workspace.fs.writeFile("/keep.txt", "x");
    await workspace.fs.writeFile("/gone.txt", "x");

    adapter.beginPrefetch("/");
    try {
      expect((await adapter.readdirWithFileTypes("/")).length).toBe(2);
      await adapter.rm("/gone.txt", {});
      expect((await adapter.readdirWithFileTypes("/")).map((e) => e.name)).toEqual(["keep.txt"]);
      await adapter.mkdir("/newdir", {});
      expect((await adapter.readdirWithFileTypes("/")).map((e) => e.name).sort()).toEqual([
        "keep.txt",
        "newdir",
      ]);
      await adapter.symlink("/keep.txt", "/alias");
      expect((await adapter.readdirWithFileTypes("/")).map((e) => e.name).sort()).toEqual([
        "alias",
        "keep.txt",
        "newdir",
      ]);
    } finally {
      adapter.endPrefetch();
    }
  });

  it("is a no-op when no prefetch scope is active", async () => {
    await seedTree();
    const find = vi.spyOn(stub, "find");
    const readdir = vi.spyOn(stub, "readdir");
    await adapter.readdirWithFileTypes("/src");
    expect(find).not.toHaveBeenCalled();
    expect(readdir).toHaveBeenCalledTimes(1);
  });

  it("falls back to a direct listing for paths outside the prefetched root", async () => {
    await seedTree();
    adapter.beginPrefetch("/src");
    try {
      const readdir = vi.spyOn(stub, "readdir");
      const entries = await adapter.readdirWithFileTypes("/node_modules");
      expect(entries.length).toBe(12);
      expect(readdir).toHaveBeenCalledTimes(1);
    } finally {
      adapter.endPrefetch();
    }
  });

  it("reports an empty directory as empty rather than missing", async () => {
    await workspace.fs.mkdir("/empty", { recursive: true });
    adapter.beginPrefetch("/");
    try {
      expect(await adapter.readdirWithFileTypes("/empty")).toEqual([]);
    } finally {
      adapter.endPrefetch();
    }
  });

  it("still throws ENOENT for a missing directory inside a scope", async () => {
    adapter.beginPrefetch("/");
    try {
      await expect(adapter.readdirWithFileTypes("/missing")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      adapter.endPrefetch();
    }
  });

  it("endPrefetch is safe to call without a matching begin", () => {
    expect(() => adapter.endPrefetch()).not.toThrow();
  });

  it("nested scopes keep the outermost prefetch until fully unwound", async () => {
    await seedTree();
    const find = vi.spyOn(stub, "find");
    adapter.beginPrefetch("/");
    adapter.beginPrefetch("/src");
    await adapter.readdirWithFileTypes("/src");
    adapter.endPrefetch();
    // Inner scope closing must not discard the outer cache.
    await adapter.readdirWithFileTypes("/node_modules");
    adapter.endPrefetch();
    expect(find).toHaveBeenCalledTimes(1);
  });
});
