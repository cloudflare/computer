import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { Workspace } from "../../workspace.js";
import { R2Bucket } from "./r2.js";

function makeStorage(): SQLiteTestStorage {
  return new SQLiteTestStorage();
}

const backends = [
  {
    id: "test",
    connect: () => Promise.reject(new Error("not used in these tests")),
  },
];

interface FakeR2Object {
  key: string;
  bytes: Uint8Array;
}

// Minimal R2Bucket shape — just enough surface for the provider.
// Covers list(prefix, cursor) and get(key) returning an object with
// a ReadableStream body. put / delete are wired in M6.
function fakeR2(objects: FakeR2Object[]): {
  bucket: R2Bucket extends (b: infer B, ...args: never[]) => unknown ? B : never;
  spy: { gets: string[]; lists: number };
} {
  const sorted = objects.slice().sort((a, b) => (a.key < b.key ? -1 : 1));
  const spy = { gets: [] as string[], lists: 0 };

  type R2GetResult = { body: ReadableStream<Uint8Array>; size: number } | null;
  const bucket = {
    async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}) {
      spy.lists++;
      const prefix = opts.prefix ?? "";
      const filtered = sorted.filter((o) => o.key.startsWith(prefix));
      const start = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
      const limit = opts.limit ?? 1000;
      const page = filtered.slice(start, start + limit);
      const nextStart = start + page.length;
      const truncated = nextStart < filtered.length;
      return {
        objects: page.map((o) => ({ key: o.key, size: o.bytes.byteLength })),
        delimitedPrefixes: [],
        truncated,
        cursor: truncated ? String(nextStart) : undefined,
      };
    },
    async get(key: string): Promise<R2GetResult> {
      spy.gets.push(key);
      const obj = sorted.find((o) => o.key === key);
      if (!obj) return null;
      const bytes = obj.bytes;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          // Emit in 64 KiB pieces so big payloads exercise the
          // streaming path without producing one giant chunk.
          const PIECE = 64 * 1024;
          for (let off = 0; off < bytes.byteLength; off += PIECE) {
            c.enqueue(bytes.subarray(off, Math.min(off + PIECE, bytes.byteLength)));
          }
          c.close();
        },
      });
      return { body: stream, size: bytes.byteLength };
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: fake satisfies the duck-typed shape we depend on
  return { bucket: bucket as any, spy };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.byteLength; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function readAll(ws: Workspace, path: string): Promise<Uint8Array> {
  const stream = await ws.fs.readFile(path);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  reader.releaseLock();
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

describe("R2Bucket provider", () => {
  it("materializes every object in the bucket under the mount root", async () => {
    const { bucket, spy } = fakeR2([
      { key: "a.txt", bytes: utf8("alpha") },
      { key: "sub/b.txt", bytes: utf8("beta") },
      { key: "sub/c.txt", bytes: utf8("gamma") },
      { key: "sub/deep/d.txt", bytes: utf8("delta") },
      { key: "z.txt", bytes: utf8("zulu") },
    ]);
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/data": R2Bucket(bucket) },
    });
    await ws.ensureMountsIndexed();
    expect(spy.gets.length).toBe(5);
    expect(new TextDecoder().decode(await readAll(ws, "/workspace/data/a.txt"))).toBe("alpha");
    expect(new TextDecoder().decode(await readAll(ws, "/workspace/data/sub/b.txt"))).toBe("beta");
    expect(new TextDecoder().decode(await readAll(ws, "/workspace/data/sub/c.txt"))).toBe("gamma");
    expect(new TextDecoder().decode(await readAll(ws, "/workspace/data/sub/deep/d.txt"))).toBe(
      "delta",
    );
    expect(new TextDecoder().decode(await readAll(ws, "/workspace/data/z.txt"))).toBe("zulu");
  });

  it("strips the prefix from R2 keys when computing relative paths", async () => {
    const { bucket } = fakeR2([
      { key: "skills/a.txt", bytes: utf8("a") },
      { key: "skills/b/c.txt", bytes: utf8("c") },
      // An object outside the prefix is not picked up.
      { key: "other.txt", bytes: utf8("nope") },
    ]);
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/skills": R2Bucket(bucket, { prefix: "skills/" }) },
    });
    await ws.ensureMountsIndexed();
    expect(new TextDecoder().decode(await readAll(ws, "/workspace/skills/a.txt"))).toBe("a");
    expect(new TextDecoder().decode(await readAll(ws, "/workspace/skills/b/c.txt"))).toBe("c");
    await expect(ws.fs.readFile("/workspace/skills/other.txt")).rejects.toThrow();
  });

  it("read-only mode rejects writes with EROFS without calling the bucket", async () => {
    const { bucket, spy } = fakeR2([{ key: "x.txt", bytes: utf8("hi") }]);
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/ro": R2Bucket(bucket) },
    });
    await ws.ensureMountsIndexed();
    spy.gets.length = 0; // ignore the materialize gets

    await expect(ws.fs.writeFile("/workspace/ro/new.txt", utf8("blocked"))).rejects.toMatchObject({
      code: "EROFS",
    });
    expect(spy.gets.length).toBe(0);
  });

  it("paginates through list() until truncated=false", async () => {
    const objs: FakeR2Object[] = [];
    for (let i = 0; i < 25; i++) {
      objs.push({ key: `f${String(i).padStart(2, "0")}.txt`, bytes: utf8(`n${i}`) });
    }
    const { bucket, spy } = fakeR2(objs);
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      // Force pagination by capping per-page entries below the
      // bucket size.
      mounts: { "/workspace/p": R2Bucket(bucket, { listLimit: 10 }) },
    });
    await ws.ensureMountsIndexed();
    // 25 entries at 10 per page → 3 list calls.
    expect(spy.lists).toBe(3);
    expect(spy.gets.length).toBe(25);
  });

  it("streams a 16 MiB object without producing oversize chunks", async () => {
    const total = 16 * 1024 * 1024;
    const big = new Uint8Array(total);
    for (let i = 0; i < total; i++) big[i] = i & 0xff;
    const { bucket } = fakeR2([{ key: "big.bin", bytes: big }]);

    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/r2": R2Bucket(bucket) },
    });
    await ws.ensureMountsIndexed();
    const readback = await readAll(ws, "/workspace/r2/big.bin");
    // Byte-equality: source and readback hash to the same sha256.
    // The chunk layout assertions below cover the streaming
    // chunker; the hash covers content correctness.
    expect(readback.byteLength).toBe(total);
    expect(await sha256Hex(readback)).toBe(await sha256Hex(big));
    // Verify the stored chunks each fit within the configured chunk
    // size — no intermediate buffer reassembled the whole 16 MiB.
    const inodeRow = ws.db.one<{ inode: number }>(
      "SELECT n.inode AS inode FROM vfs_nodes n JOIN vfs_dirents d ON d.child_inode = n.inode WHERE d.name = 'big.bin'",
    );
    expect(inodeRow).toBeDefined();
    const chunks = ws.db.all<{ size: number }>(
      "SELECT size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
      // biome-ignore lint/style/noNonNullAssertion: existence asserted above
      inodeRow!.inode,
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.size).toBeLessThanOrEqual(512 * 1024);
    }
    expect(chunks.reduce((s, c) => s + c.size, 0)).toBe(total);
  });

  it("materialize on an empty bucket creates the mount root with no children", async () => {
    const { bucket, spy } = fakeR2([]);
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/empty": R2Bucket(bucket) },
    });
    await ws.ensureMountsIndexed();
    // No get() calls because list() returned nothing.
    expect(spy.gets.length).toBe(0);
    const row = ws.db.one<{ root: string; indexed: number }>(
      "SELECT root, indexed FROM _vfs_mounts WHERE root = ?",
      "/workspace/empty",
    );
    expect(row).toEqual({ root: "/workspace/empty", indexed: 1 });
    // The indexer pre-creates the mount root, so even when the
    // backing bucket is empty the configured root resolves and
    // readdir returns []. A consumer enumerating an empty mount
    // doesn't need to know whether the bucket happened to be
    // empty.
    await expect(ws.fs.readdir("/workspace/empty")).resolves.toEqual([]);
  });

  it("materialize throws if get() returns null for a listed key", async () => {
    // A bucket whose list() reports a key but whose get() returns
    // null for it — the object was deleted between the two calls.
    // The indexer must reject and roll back the subtree.
    const sorted: Array<{ key: string; size: number }> = [{ key: "present.txt", size: 5 }];
    const bucket = {
      async list() {
        return {
          objects: sorted,
          delimitedPrefixes: [],
          truncated: false,
          cursor: undefined as string | undefined,
        };
      },
      async get() {
        return null;
      },
      // biome-ignore lint/suspicious/noExplicitAny: duck-typed fake
    } as any;
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/lost": R2Bucket(bucket) },
    });
    await expect(ws.ensureMountsIndexed()).rejects.toThrow(/disappeared mid-materialize/);
    const row = ws.db.one<{ indexed: number }>(
      "SELECT indexed FROM _vfs_mounts WHERE root = ?",
      "/workspace/lost",
    );
    expect(row?.indexed ?? 0).toBe(0);
    await expect(ws.fs.readdir("/workspace/lost")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
