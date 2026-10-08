import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { applyChanges } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { afterEach, describe, expect, it } from "vitest";

import { Workspace } from "../../workspace.js";
import type { EagerMount } from "../types.js";
import { createWorkerBundle, WorkerBundle, type WorkerBundleOptions } from "./worker-bundle.js";

const backends = [
  {
    id: "test",
    connect: () => Promise.reject(new Error("not used in these tests")),
  },
];

const ROOT = "/workspace/templates";
const BINARY = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x7f]);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "worker-bundle-"));
  tempDirs.push(dir);
  return dir;
}

type Tree = Record<string, string | Uint8Array | null>;

function writeTree(base: string, tree: Tree): string {
  mkdirSync(base, { recursive: true });
  for (const [path, contents] of Object.entries(tree)) {
    const abs = join(base, path);
    if (contents === null) {
      mkdirSync(abs, { recursive: true });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return base;
}

function sampleTree(): Tree {
  return {
    "app/package.json": '{"name":"app"}\n',
    "app/src/index.ts": "export const x = 1;\n",
    "scripts/setup.sh": "#!/bin/sh\necho setup\n",
    "assets/blob.bin": BINARY,
    "drafts/wip.txt": "draft\n",
    "README.txt": "readme\n",
    empty: null,
  };
}

async function indexed(mount: EagerMount, storage = new SQLiteTestStorage()): Promise<Workspace> {
  const ws = new Workspace({ storage, backends, mounts: { [ROOT]: mount } });
  await ws.ensureMountsIndexed();
  return ws;
}

async function readBytes(ws: Workspace, path: string): Promise<Uint8Array> {
  const stream = await ws.fs.readFile(path);
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function modeOf(ws: Workspace, path: string): Promise<number> {
  return (await ws.fs.stat(path)).mode & 0o777;
}

function bundle(
  path: string,
  options: WorkerBundleOptions = {},
  bundleDir = "/bundle",
): EagerMount {
  return createWorkerBundle(path, options, { bundleDir });
}

describe("WorkerBundle", () => {
  it("returns a read-only eager mount", () => {
    const dir = writeTree(tempDir(), sampleTree());
    const mount = WorkerBundle(dir, { maxBytes: 10, maxEntries: 20 });
    expect(mount.kind).toBe("worker-bundle");
    expect(mount.strategy).toBe("eager");
    expect(mount.mode).toBe("read-only");
    expect(mount.maxBytes).toBe(10);
    expect(mount.maxEntries).toBe(20);
  });

  it("copies the tree under the mount root with the same paths", async () => {
    const dir = writeTree(tempDir(), sampleTree());
    const ws = await indexed(WorkerBundle(dir));
    expect(await ws.fs.readFile(`${ROOT}/app/package.json`, "utf8")).toBe('{"name":"app"}\n');
    expect(await ws.fs.readFile(`${ROOT}/app/src/index.ts`, "utf8")).toBe("export const x = 1;\n");
    expect(await ws.fs.readFile(`${ROOT}/README.txt`, "utf8")).toBe("readme\n");
    expect((await ws.fs.readdir(ROOT)).map((entry) => entry.name).sort()).toEqual(
      ["README.txt", "app", "assets", "drafts", "empty", "scripts"].sort(),
    );
  });

  it("copies binary files byte for byte", async () => {
    const dir = writeTree(tempDir(), sampleTree());
    const ws = await indexed(WorkerBundle(dir));
    expect(await readBytes(ws, `${ROOT}/assets/blob.bin`)).toEqual(BINARY);
  });

  it("creates empty directories", async () => {
    const dir = writeTree(tempDir(), sampleTree());
    const ws = await indexed(WorkerBundle(dir));
    expect((await ws.fs.stat(`${ROOT}/empty`)).isDirectory).toBe(true);
    expect(await ws.fs.readdir(`${ROOT}/empty`)).toEqual([]);
  });

  it("marks files that start with #! as executable", async () => {
    const dir = writeTree(tempDir(), sampleTree());
    const ws = await indexed(WorkerBundle(dir));
    expect(await modeOf(ws, `${ROOT}/scripts/setup.sh`)).toBe(0o755);
    expect(await modeOf(ws, `${ROOT}/README.txt`)).toBe(0o644);
    expect(await modeOf(ws, `${ROOT}/assets/blob.bin`)).toBe(0o644);
  });

  it("uses fileMode when it returns a mode and the default otherwise", async () => {
    const dir = writeTree(tempDir(), sampleTree());
    const ws = await indexed(
      WorkerBundle(dir, {
        fileMode: (path) => (path === "README.txt" ? 0o600 : undefined),
      }),
    );
    expect(await modeOf(ws, `${ROOT}/README.txt`)).toBe(0o600);
    expect(await modeOf(ws, `${ROOT}/scripts/setup.sh`)).toBe(0o755);
  });

  it("passes the relative path and bytes to fileMode", async () => {
    const dir = writeTree(tempDir(), { "a/b.bin": BINARY });
    const seen: Array<[string, Uint8Array]> = [];
    await indexed(
      WorkerBundle(dir, {
        fileMode: (path, bytes) => {
          seen.push([path, bytes]);
          return undefined;
        },
      }),
    );
    expect(seen.map(([path]) => path)).toContain("a/b.bin");
    expect(seen.find(([path]) => path === "a/b.bin")?.[1]).toEqual(BINARY);
  });

  it("skips files the filter rejects", async () => {
    const dir = writeTree(tempDir(), sampleTree());
    const ws = await indexed(WorkerBundle(dir, { filter: ({ path }) => path !== "README.txt" }));
    await expect(ws.fs.readFile(`${ROOT}/README.txt`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await ws.fs.readFile(`${ROOT}/app/package.json`, "utf8")).toBe('{"name":"app"}\n');
  });

  it("skips a whole subtree when the filter rejects a directory", async () => {
    const dir = writeTree(tempDir(), sampleTree());
    const seen: string[] = [];
    const ws = await indexed(
      WorkerBundle(dir, {
        filter: (entry) => {
          seen.push(entry.path);
          return !(entry.type === "dir" && entry.path === "drafts");
        },
      }),
    );
    await expect(ws.fs.stat(`${ROOT}/drafts`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(seen).not.toContain("drafts/wip.txt");
  });

  it("resolves a relative path against the bundle directory", async () => {
    const bundleDir = tempDir();
    writeTree(join(bundleDir, "templates"), sampleTree());
    const ws = await indexed(bundle("templates", {}, bundleDir));
    expect(await ws.fs.readFile(`${ROOT}/README.txt`, "utf8")).toBe("readme\n");
  });

  it("explains how to ship the files when the directory is missing", () => {
    const bundleDir = tempDir();
    writeFileSync(join(bundleDir, "index.js"), "");
    expect(() => bundle("templates", {}, bundleDir)).toThrow(/does not exist/);
    expect(() => bundle("templates", {}, bundleDir)).toThrow(/find_additional_modules/);
    expect(() => bundle("templates", {}, bundleDir)).toThrow(/templates\/\*\*\/\*/);
    expect(() => bundle("templates", {}, bundleDir)).toThrow(
      /workerBundle\(\{ dir: "src\/templates" \}\)/,
    );
  });

  it("explains that vite dev is not supported when running under it", () => {
    const bundleDir = tempDir();
    writeFileSync(join(bundleDir, "__VITE_WORKER_ENTRY__"), "");
    expect(() => bundle("templates", {}, bundleDir)).toThrow(/vite dev/);
    expect(() => bundle("templates", {}, bundleDir)).not.toThrow(/find_additional_modules/);
  });

  it("rejects a path that is a file", () => {
    const dir = writeTree(tempDir(), sampleTree());
    expect(() => WorkerBundle(join(dir, "README.txt"))).toThrow(/not a directory/);
  });

  it("rejects paths with .. segments", () => {
    expect(() => WorkerBundle("../etc")).toThrow(/'\.\.'/);
    expect(() => WorkerBundle("templates/../../etc")).toThrow(/'\.\.'/);
  });

  it("rejects an empty path", () => {
    expect(() => WorkerBundle("")).toThrow(/must not be empty/);
  });

  it("rejects writes through Workspace.fs after indexing", async () => {
    const dir = writeTree(tempDir(), sampleTree());
    const ws = await indexed(WorkerBundle(dir));
    await expect(
      ws.fs.writeFile(`${ROOT}/new.txt`, new TextEncoder().encode("x")),
    ).rejects.toMatchObject({ code: "EROFS" });
  });

  it("drops container writes under the root on pull", async () => {
    const dir = writeTree(tempDir(), sampleTree());
    const ws = await indexed(WorkerBundle(dir));
    const result = await applyChanges(
      ws.db,
      [
        {
          kind: "file",
          rev: 1000,
          path: `${ROOT}/from-container.txt`,
          mode: 0o644,
          mtime: 1,
          size: 0,
          chunks: [],
        },
      ],
      new Map(),
    );
    expect(result.applied).toBe(0);
    expect(result.skipped).toEqual([
      { path: `${ROOT}/from-container.txt`, mountRoot: ROOT, op: "write", reason: "read-only" },
    ]);
  });

  it("rolls back when maxEntries is exceeded", async () => {
    const dir = writeTree(tempDir(), sampleTree());
    const storage = new SQLiteTestStorage();
    const ws = new Workspace({
      storage,
      backends,
      mounts: { [ROOT]: WorkerBundle(dir, { maxEntries: 2 }) },
    });
    await expect(ws.ensureMountsIndexed()).rejects.toThrow(/maxEntries/);
    const row = ws.db.one<{ indexed: number }>(
      "SELECT indexed FROM _vfs_mounts WHERE root = ?",
      ROOT,
    );
    expect(row?.indexed).toBe(0);
    await expect(ws.fs.readdir(ROOT)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("WorkerBundle versions", () => {
  it("uses an explicit version as-is", () => {
    const dir = writeTree(tempDir(), sampleTree());
    expect(WorkerBundle(dir, { version: "build-42" }).version).toBe("build-42");
  });

  it("leaves the version unset when version is false", () => {
    const dir = writeTree(tempDir(), sampleTree());
    expect(WorkerBundle(dir, { version: false }).version).toBeUndefined();
  });

  it("gives the same content the same hash", () => {
    const a = writeTree(tempDir(), sampleTree());
    const b = writeTree(tempDir(), sampleTree());
    const versionA = WorkerBundle(a).version;
    expect(versionA).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(WorkerBundle(b).version).toBe(versionA);
  });

  it("changes the hash when one byte changes and the size stays the same", () => {
    const a = writeTree(tempDir(), sampleTree());
    const b = writeTree(tempDir(), { ...sampleTree(), "README.txt": "reaDme\n" });
    expect(WorkerBundle(b).version).not.toBe(WorkerBundle(a).version);
  });

  it("changes the hash when a path changes", () => {
    const a = writeTree(tempDir(), { "a.txt": "x" });
    const b = writeTree(tempDir(), { "b.txt": "x" });
    expect(WorkerBundle(b).version).not.toBe(WorkerBundle(a).version);
  });

  it("changes the hash when an empty directory is added", () => {
    const a = writeTree(tempDir(), { "a.txt": "x" });
    const b = writeTree(tempDir(), { "a.txt": "x", empty: null });
    expect(WorkerBundle(b).version).not.toBe(WorkerBundle(a).version);
  });

  it("changes the hash when fileMode changes a mode", () => {
    const a = writeTree(tempDir(), { "a.txt": "x" });
    const b = writeTree(tempDir(), { "a.txt": "x" });
    expect(WorkerBundle(b, { fileMode: () => 0o700 }).version).not.toBe(WorkerBundle(a).version);
  });

  it("ignores files the filter skips", () => {
    const filter = ({ path }: { path: string }) => !path.startsWith("drafts");
    const a = writeTree(tempDir(), sampleTree());
    const b = writeTree(tempDir(), {
      ...sampleTree(),
      "drafts/wip.txt": "something else entirely\n",
    });
    expect(WorkerBundle(b, { filter }).version).toBe(WorkerBundle(a, { filter }).version);
  });

  it("computes the hash once per directory", () => {
    const dir = writeTree(tempDir(), { "a.txt": "one" });
    const first = WorkerBundle(dir).version;
    writeFileSync(join(dir, "a.txt"), "two");
    expect(WorkerBundle(dir).version).toBe(first);
  });

  it("caches separately for different filters", () => {
    const dir = writeTree(tempDir(), { "a.txt": "one", "b.txt": "two" });
    const all = WorkerBundle(dir).version;
    const onlyA = WorkerBundle(dir, { filter: ({ path }) => path === "a.txt" }).version;
    expect(onlyA).not.toBe(all);
  });

  it("re-materializes on a new deploy and skips an unchanged one", async () => {
    const storage = new SQLiteTestStorage();
    const v1 = writeTree(tempDir(), { "a.txt": "one", "old.txt": "old" });
    const first = await indexed(WorkerBundle(v1, { version: "1" }), storage);
    expect(await first.fs.readFile(`${ROOT}/a.txt`, "utf8")).toBe("one");

    const v2 = writeTree(tempDir(), { "a.txt": "two" });
    const second = await indexed(WorkerBundle(v2, { version: "2" }), storage);
    expect(await second.fs.readFile(`${ROOT}/a.txt`, "utf8")).toBe("two");
    await expect(second.fs.readFile(`${ROOT}/old.txt`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const unchanged = writeTree(tempDir(), { "a.txt": "three" });
    const third = await indexed(WorkerBundle(unchanged, { version: "2" }), storage);
    expect(await third.fs.readFile(`${ROOT}/a.txt`, "utf8")).toBe("two");
  });
});
