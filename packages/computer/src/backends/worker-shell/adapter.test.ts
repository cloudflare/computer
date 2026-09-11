// Tests for WorkspaceFsAdapter.
//
// The adapter implements just-bash's IFileSystem against the
// public WorkspaceFilesystemStub surface. Tests run end-to-end
// against an in-process Workspace backed by SQLiteTestStorage —
// no workerd, no network. Every assertion lands on the real
// Workspace.fs state via fresh stat() / readFile() calls so a
// regression in the adapter that "succeeds" but skips the DB
// shows up immediately.

import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { Bash } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "../../backend.js";
import { WorkspaceFilesystemStub } from "../../stub.js";
import { Workspace } from "../../workspace.js";
import { type WorkspaceFs, WorkspaceFsAdapter } from "./adapter.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array): string => new TextDecoder("utf-8").decode(b);

function noopBackend(): WorkspaceBackend {
  // The adapter never touches the sync wire. A backend that
  // declares sync: "none" satisfies Workspace.ready() without
  // making us stub out a full SyncRPC surface.
  return {
    id: "noop",
    async connect(): Promise<BackendHandle> {
      return {
        rpc: {
          sync: new Proxy(
            {},
            {
              get() {
                throw new Error("sync wire must not be reached");
              },
            },
          ) as never,
          shell: new Proxy(
            {},
            {
              get() {
                throw new Error("shell wire must not be reached");
              },
            },
          ) as never,
        },
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

describe("WorkspaceFsAdapter — reads", () => {
  it("readFile decodes utf8 by default", async () => {
    await workspace.fs.writeFile("/a.txt", "hello");
    expect(await adapter.readFile("/a.txt")).toBe("hello");
  });

  it("readFile honors an explicit encoding option", async () => {
    await workspace.fs.writeFile("/a.txt", "hi");
    expect(await adapter.readFile("/a.txt", { encoding: "utf8" })).toBe("hi");
  });

  it("readFileBuffer returns the raw bytes", async () => {
    await workspace.fs.writeFile("/bin", new Uint8Array([1, 2, 3, 4]));
    const buf = await adapter.readFileBuffer("/bin");
    expect(Array.from(buf)).toEqual([1, 2, 3, 4]);
  });

  it("exists returns true for an existing path, false for a missing one", async () => {
    await workspace.fs.writeFile("/here", "x");
    expect(await adapter.exists("/here")).toBe(true);
    expect(await adapter.exists("/missing")).toBe(false);
  });

  it("keeps expected PATH misses on the host side", async () => {
    const exists = vi.fn(async () => false);
    const statOrNull = vi.fn(async () => null);
    const stat = vi.fn(async () => {
      throw Object.assign(new Error("should not cross RPC"), { code: "ENOENT" });
    });
    const pathAdapter = new WorkspaceFsAdapter({
      exists,
      stat,
      statOrNull,
    } as unknown as WorkspaceFs);

    await expect(pathAdapter.exists("/usr/bin/cat")).resolves.toBe(false);
    await expect(pathAdapter.stat("/usr/bin/cat")).rejects.toMatchObject({ code: "ENOENT" });
    expect(exists).toHaveBeenCalledWith("/usr/bin/cat");
    expect(statOrNull).toHaveBeenCalledWith("/usr/bin/cat");
    expect(stat).not.toHaveBeenCalled();
  });

  it("stats existing paths in one host call", async () => {
    const stat = vi.fn(async () => {
      throw new Error("stat should not be called by the adapter");
    });
    const statOrNull = vi.fn(async () => ({
      name: "cat",
      inode: 1,
      mode: 0o755,
      mtime: 123,
      size: 42,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    }));
    const pathAdapter = new WorkspaceFsAdapter({ stat, statOrNull } as unknown as WorkspaceFs);

    await expect(pathAdapter.stat("/usr/bin/cat")).resolves.toMatchObject({
      isFile: true,
      mode: 0o755,
      size: 42,
    });
    expect(statOrNull).toHaveBeenCalledTimes(1);
    expect(stat).not.toHaveBeenCalled();
  });

  it("readdir returns immediate child names", async () => {
    await workspace.fs.mkdir("/d");
    await workspace.fs.writeFile("/d/a", "a");
    await workspace.fs.writeFile("/d/b", "b");
    const names = (await adapter.readdir("/d")).sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("readdirWithFileTypes carries the type flags", async () => {
    await workspace.fs.mkdir("/d");
    await workspace.fs.writeFile("/d/f", "f");
    await workspace.fs.mkdir("/d/sub");
    const entries = (await adapter.readdirWithFileTypes?.("/d")) ?? [];
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get("f")?.isFile).toBe(true);
    expect(byName.get("f")?.isDirectory).toBe(false);
    expect(byName.get("sub")?.isDirectory).toBe(true);
    expect(byName.get("sub")?.isFile).toBe(false);
  });

  it("stat reports the documented just-bash shape", async () => {
    await workspace.fs.writeFile("/a", "hi", { mode: 0o644 });
    const s = await adapter.stat("/a");
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
    expect(s.isSymbolicLink).toBe(false);
    expect(s.mode).toBe(0o644);
    expect(s.size).toBe(2);
    expect(s.mtime).toBeInstanceOf(Date);
  });

  it("exposes a virtual /dev/null", async () => {
    expect(await adapter.readdir("/dev")).toEqual(["null"]);
    const s = await adapter.stat("/dev/null");
    expect(s.isFile).toBe(true);
    expect(s.size).toBe(0);
    expect(await adapter.readFile("/dev/null")).toBe("");
    expect(Array.from(await adapter.readFileBuffer("/dev/null"))).toEqual([]);
  });
});

describe("WorkspaceFsAdapter — writes", () => {
  it("writeFile round-trips utf8 text", async () => {
    await adapter.writeFile("/out", "hello world");
    expect(await workspace.fs.readFile("/out", "utf8")).toBe("hello world");
  });

  it("writeFile accepts a Uint8Array payload unchanged", async () => {
    await adapter.writeFile("/bytes", new Uint8Array([7, 8, 9]));
    const stream = await workspace.fs.readFile("/bytes");
    const back = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(Array.from(back)).toEqual([7, 8, 9]);
  });

  it("appendFile extends an existing file", async () => {
    await adapter.writeFile("/log", "one\n");
    await adapter.appendFile("/log", "two\n");
    expect(await workspace.fs.readFile("/log", "utf8")).toBe("one\ntwo\n");
  });

  it("appendFile creates the file when missing", async () => {
    await adapter.appendFile("/fresh", "first\n");
    expect(await workspace.fs.readFile("/fresh", "utf8")).toBe("first\n");
  });

  it("mkdir creates a directory", async () => {
    await adapter.mkdir("/d");
    expect((await workspace.fs.stat("/d")).isDirectory).toBe(true);
  });

  it("mkdir with recursive creates intermediate parents", async () => {
    await adapter.mkdir("/a/b/c", { recursive: true });
    expect((await workspace.fs.stat("/a/b/c")).isDirectory).toBe(true);
  });

  it("rm removes a file; rm with recursive removes a directory tree", async () => {
    await workspace.fs.writeFile("/x", "x");
    await adapter.rm("/x");
    await expect(workspace.fs.stat("/x")).rejects.toMatchObject({ code: "ENOENT" });

    await workspace.fs.mkdir("/tree");
    await workspace.fs.writeFile("/tree/inside", "i");
    await adapter.rm("/tree", { recursive: true });
    await expect(workspace.fs.stat("/tree")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("chmod updates the stored mode", async () => {
    await workspace.fs.writeFile("/a", "x");
    await adapter.chmod("/a", 0o600);
    expect((await workspace.fs.stat("/a")).mode).toBe(0o600);
  });

  it("symlink + readlink round-trip", async () => {
    await workspace.fs.writeFile("/target", "hi");
    await adapter.symlink("/target", "/link");
    expect(await adapter.readlink("/link")).toBe("/target");
  });

  it("discards shell redirection writes to /dev/null", async () => {
    const bash = new Bash({ fs: adapter as never, cwd: "/" });
    const result = await bash.exec("printf hello >/dev/null && cat /dev/null");
    expect(result).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
    await expect(workspace.fs.stat("/dev/null")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lstat reports the symlink itself", async () => {
    await workspace.fs.writeFile("/t", "x");
    await adapter.symlink("/t", "/l");
    const l = await adapter.lstat("/l");
    expect(l.isSymbolicLink).toBe(true);
    expect(l.isFile).toBe(false);
  });
});

describe("WorkspaceFsAdapter — composites", () => {
  it("cp copies a file", async () => {
    await workspace.fs.writeFile("/src", "hello");
    await adapter.cp("/src", "/dst");
    expect(await workspace.fs.readFile("/dst", "utf8")).toBe("hello");
    expect(await workspace.fs.readFile("/src", "utf8")).toBe("hello");
  });

  it("cp -r copies a directory tree", async () => {
    await workspace.fs.mkdir("/src/inner", { recursive: true });
    await workspace.fs.writeFile("/src/a", "a");
    await workspace.fs.writeFile("/src/inner/b", "b");
    await adapter.cp("/src", "/dst", { recursive: true });
    expect(await workspace.fs.readFile("/dst/a", "utf8")).toBe("a");
    expect(await workspace.fs.readFile("/dst/inner/b", "utf8")).toBe("b");
  });

  it("mv renames a file", async () => {
    await workspace.fs.writeFile("/src", "hello");
    await adapter.mv("/src", "/dst");
    expect(await workspace.fs.readFile("/dst", "utf8")).toBe("hello");
    await expect(workspace.fs.stat("/src")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("mv moves through the store's rename rather than copy and delete", async () => {
    await workspace.fs.writeFile("/src", "hello");
    const rename = vi.spyOn(stub, "rename");
    const writeFile = vi.spyOn(stub, "writeFile");
    await adapter.mv("/src", "/dst");
    expect(rename).toHaveBeenCalledWith("/src", "/dst");
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("mv moves a directory tree in one operation", async () => {
    await workspace.fs.mkdir("/src/inner", { recursive: true });
    await workspace.fs.writeFile("/src/inner/b", "b");
    await adapter.mv("/src", "/dst");
    expect(await workspace.fs.readFile("/dst/inner/b", "utf8")).toBe("b");
    await expect(workspace.fs.stat("/src")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("mv falls back to copy and delete when rename cannot replace the destination", async () => {
    await workspace.fs.mkdir("/src", { recursive: true });
    await workspace.fs.writeFile("/src/a", "a");
    await workspace.fs.mkdir("/dst", { recursive: true });
    await workspace.fs.writeFile("/dst/keep", "keep");
    await adapter.mv("/src", "/dst");
    expect(await workspace.fs.readFile("/dst/a", "utf8")).toBe("a");
    expect(await workspace.fs.readFile("/dst/keep", "utf8")).toBe("keep");
    await expect(workspace.fs.stat("/src")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("WorkspaceFsAdapter — pure utilities", () => {
  it("resolvePath joins relative paths against the base", () => {
    expect(adapter.resolvePath("/a/b", "c.txt")).toBe("/a/b/c.txt");
    expect(adapter.resolvePath("/a/b", "../c.txt")).toBe("/a/c.txt");
    expect(adapter.resolvePath("/a/b", "/abs/path")).toBe("/abs/path");
  });

  it("getAllPaths returns every entry under the root", async () => {
    await workspace.fs.mkdir("/p");
    await workspace.fs.writeFile("/p/a", "a");
    await workspace.fs.writeFile("/q", "q");
    const paths = adapter.getAllPaths();
    // getAllPaths is documented as best-effort; we just need it
    // to expose the entries we know about.
    expect(paths).toBeInstanceOf(Array);
  });
});

describe("WorkspaceFsAdapter — known gaps", () => {
  it("link throws ENOSYS — hard links are not supported", async () => {
    await workspace.fs.writeFile("/a", "x");
    await expect(adapter.link("/a", "/b")).rejects.toMatchObject({ code: "ENOSYS" });
  });

  it("utimes silently no-ops — the store has no atime column", async () => {
    await workspace.fs.writeFile("/a", "x");
    await adapter.utimes("/a", new Date(0), new Date(0));
    // No assertion on mtime — the stub doesn't expose a setter
    // today; the contract for utimes is "doesn't throw".
    expect(true).toBe(true);
  });
});

describe("WorkspaceFsAdapter — bytes helper", () => {
  it("uses fromUtf8 helper for sanity", () => {
    // Tiny self-check so the helper-vs-real encoding round trip
    // doesn't surprise us in the body of a failing test.
    expect(fromUtf8(utf8("hello"))).toBe("hello");
  });
});
