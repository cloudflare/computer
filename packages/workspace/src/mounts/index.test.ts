import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it, vi } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "../backend.js";
import { Workspace } from "../workspace.js";
import type { EagerMount, MountWriteAPI } from "./types.js";

function makeStorage(): SQLiteTestStorage {
  return new SQLiteTestStorage();
}

const backends = [
  {
    id: "test",
    connect: () => Promise.reject(new Error("not used in these tests")),
  },
];

// Build a ReadableStream<Uint8Array> from a single byte payload.
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // crypto.subtle.digest accepts an ArrayBuffer view; the cast keeps
  // TypeScript happy without copying. Returned as a hex string so
  // expect(x).toBe(y) gives a readable diff on mismatch.
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.byteLength; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

interface FakeFile {
  path: string;
  bytes: Uint8Array;
  mode?: number;
}

function fakeMount(opts: {
  files: FakeFile[];
  dirs?: Array<{ path: string; mode?: number }>;
  kind?: string;
  mode?: "read-only" | "read-write";
  onMaterialize?: () => void;
  throwAfter?: number; // throw after writing N files
}): EagerMount & { calls: number } {
  return {
    kind: opts.kind ?? "fake",
    mode: opts.mode ?? "read-only",
    strategy: "eager",
    calls: 0,
    async materialize(api: MountWriteAPI) {
      // biome-ignore lint/suspicious/noExplicitAny: self-reference for the call counter
      (this as any).calls += 1;
      opts.onMaterialize?.();
      for (const d of opts.dirs ?? []) {
        await api.mkdir(d.path, d.mode);
      }
      let i = 0;
      for (const f of opts.files) {
        if (opts.throwAfter !== undefined && i >= opts.throwAfter) {
          throw new Error("boom mid-materialize");
        }
        await api.writeFile(f.path, streamOf(f.bytes), f.mode);
        i++;
      }
    },
  };
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

describe("mount indexer", () => {
  it("materializes files into vfs_nodes and reads bypass the mount", async () => {
    const mount = fakeMount({
      files: [
        { path: "/workspace/data/a.txt", bytes: utf8("alpha") },
        { path: "/workspace/data/sub/b.txt", bytes: utf8("beta") },
        { path: "/workspace/data/sub/c.txt", bytes: utf8("gamma") },
      ],
    });
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/data": mount },
    });
    await ws.ensureMountsIndexed();
    expect(mount.calls).toBe(1);

    expect(new TextDecoder().decode(await readAll(ws, "/workspace/data/a.txt"))).toBe("alpha");
    expect(new TextDecoder().decode(await readAll(ws, "/workspace/data/sub/b.txt"))).toBe("beta");
    expect(new TextDecoder().decode(await readAll(ws, "/workspace/data/sub/c.txt"))).toBe("gamma");

    // Reads must not re-invoke the mount.
    expect(mount.calls).toBe(1);
  });

  it("records one row per mount in _vfs_mounts with kind, mode, and indexed=1", async () => {
    const m1 = fakeMount({
      kind: "kind-1",
      files: [{ path: "/workspace/a/f.txt", bytes: utf8("x") }],
    });
    const m2 = fakeMount({
      kind: "kind-2",
      mode: "read-write",
      files: [{ path: "/workspace/b/g.txt", bytes: utf8("y") }],
    });
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/a": m1, "/workspace/b": m2 },
    });
    await ws.ensureMountsIndexed();
    const rows = ws.db
      .all<{ root: string; kind: string; mode: string; indexed: number }>(
        "SELECT root, kind, mode, indexed FROM _vfs_mounts ORDER BY root",
      )
      .map((r) => ({ ...r }));
    expect(rows).toEqual([
      { root: "/workspace/a", kind: "kind-1", mode: "read-only", indexed: 1 },
      { root: "/workspace/b", kind: "kind-2", mode: "read-write", indexed: 1 },
    ]);
  });

  it("stamps vfs_nodes.mount_root on every materialised node, root included", async () => {
    const mount = fakeMount({
      kind: "stamp",
      files: [
        { path: "/workspace/m/a.txt", bytes: utf8("alpha") },
        { path: "/workspace/m/sub/b.txt", bytes: utf8("beta") },
      ],
    });
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/m": mount },
    });
    await ws.ensureMountsIndexed();
    // Every node visible under /workspace/m (the dir itself plus
    // every descendant the fake mount wrote) carries the mount
    // provenance.
    const stamped = ws.db.all<{ mount_root: string | null }>(
      "SELECT mount_root FROM vfs_nodes WHERE mount_root IS NOT NULL",
    );
    // Mount root inode + 'sub' dir + 2 files = 4 stamped rows.
    expect(stamped.length).toBe(4);
    expect(stamped.every((r) => r.mount_root === "/workspace/m")).toBe(true);
    // Nodes outside the mount (the workspace root, for instance)
    // are not stamped.
    const unstamped = ws.db.all<{ inode: number }>(
      "SELECT inode FROM vfs_nodes WHERE mount_root IS NULL",
    );
    expect(unstamped.length).toBeGreaterThan(0);
  });

  it("a read-only mount rejects ws.fs.writeFile under the root with EROFS", async () => {
    // The EROFS now comes from dofs's data-layer guard, not from
    // a workspace-side wrapper. The check is run before the write
    // touches the DB.
    const mount = fakeMount({
      kind: "ro",
      mode: "read-only",
      files: [{ path: "/workspace/ro/seed.txt", bytes: utf8("seed") }],
    });
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/ro": mount },
    });
    await ws.ensureMountsIndexed();
    await expect(ws.fs.writeFile("/workspace/ro/new.txt", utf8("blocked"))).rejects.toMatchObject({
      code: "EROFS",
    });
  });

  it("a read-write mount accepts ws.fs.writeFile under the root", async () => {
    const mount = fakeMount({
      kind: "rw",
      mode: "read-write",
      files: [{ path: "/workspace/rw/seed.txt", bytes: utf8("seed") }],
    });
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/rw": mount },
    });
    await ws.ensureMountsIndexed();
    await ws.fs.writeFile("/workspace/rw/new.txt", utf8("ok"));
    expect(await ws.fs.readFile("/workspace/rw/new.txt", "utf8")).toBe("ok");
  });

  it("a read-only mount rejects ws.fs.rm and ws.fs.mkdir with EROFS", async () => {
    const mount = fakeMount({
      kind: "ro",
      mode: "read-only",
      files: [{ path: "/workspace/ro/seed.txt", bytes: utf8("seed") }],
    });
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/ro": mount },
    });
    await ws.ensureMountsIndexed();
    await expect(ws.fs.rm("/workspace/ro/seed.txt", { force: true })).rejects.toMatchObject({
      code: "EROFS",
    });
    await expect(ws.fs.mkdir("/workspace/ro/sub", { recursive: true })).rejects.toMatchObject({
      code: "EROFS",
    });
  });

  it("ws.fs.rm of an ancestor of a read-only mount root is rejected", async () => {
    // Ancestor-rm is the destructive shape we have to keep covered
    // end-to-end: rm('/workspace', { recursive, force }) would
    // recurse through /workspace/ro and silently wipe the mount.
    // The dofs guard's overlapsRoot is symmetric so the check
    // catches both descendant and ancestor paths.
    const mount = fakeMount({
      kind: "ro",
      mode: "read-only",
      files: [{ path: "/workspace/ro/seed.txt", bytes: utf8("seed") }],
    });
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/ro": mount },
    });
    await ws.ensureMountsIndexed();
    await expect(ws.fs.rm("/workspace", { recursive: true, force: true })).rejects.toMatchObject({
      code: "EROFS",
    });
  });

  it("writes outside any mount root pass through unchanged", async () => {
    const mount = fakeMount({
      kind: "ro",
      mode: "read-only",
      files: [{ path: "/workspace/ro/seed.txt", bytes: utf8("seed") }],
    });
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/ro": mount },
    });
    await ws.ensureMountsIndexed();
    // A sibling directory accepts the usual mkdir / write / rm.
    await ws.fs.mkdir("/workspace/free", { recursive: true });
    await ws.fs.writeFile("/workspace/free/a.txt", utf8("ok"));
    expect(await ws.fs.readFile("/workspace/free/a.txt", "utf8")).toBe("ok");
    await ws.fs.rm("/workspace/free/a.txt");
    await expect(ws.fs.readFile("/workspace/free/a.txt", "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not re-materialize on a second workspace over the same store", async () => {
    const storage = makeStorage();
    const mount1 = fakeMount({ files: [{ path: "/workspace/m/x.txt", bytes: utf8("hi") }] });
    const ws1 = new Workspace({
      storage,
      backends,
      mounts: { "/workspace/m": mount1 },
    });
    await ws1.ensureMountsIndexed();
    expect(mount1.calls).toBe(1);

    const mount2 = fakeMount({ files: [{ path: "/workspace/m/x.txt", bytes: utf8("hi") }] });
    const ws2 = new Workspace({
      storage,
      backends,
      mounts: { "/workspace/m": mount2 },
    });
    await ws2.ensureMountsIndexed();
    expect(mount2.calls).toBe(0);
    expect(new TextDecoder().decode(await readAll(ws2, "/workspace/m/x.txt"))).toBe("hi");
  });

  it("streams a 1 MiB writeFile in 4 KiB chunks into multiple stored chunks", async () => {
    const total = 1 << 20; // 1 MiB
    const pieceSize = 4 * 1024; // 4 KiB
    const big = new Uint8Array(total);
    for (let i = 0; i < total; i++) big[i] = i & 0xff;
    const source = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let off = 0; off < total; off += pieceSize) {
            controller.enqueue(big.subarray(off, Math.min(off + pieceSize, total)));
          }
          controller.close();
        },
      });
    const mount: EagerMount = {
      kind: "big",
      mode: "read-only",
      strategy: "eager",
      async materialize(api) {
        await api.writeFile("/workspace/big/blob.bin", source());
      },
    };
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/big": mount },
    });
    await ws.ensureMountsIndexed();
    const bytes = await readAll(ws, "/workspace/big/blob.bin");
    expect(bytes.byteLength).toBe(total);
    // Byte-equality: source and readback hash to the same sha256.
    // The chunk-count + per-chunk-size assertions below cover the
    // chunker layout; the hash covers content correctness.
    expect(await sha256Hex(bytes)).toBe(await sha256Hex(big));
    // The dofs CHUNK_SIZE is 512 KiB; a 1 MiB blob should land
    // exactly two chunks.
    const inodeRow = ws.db.one<{ inode: number }>(
      "SELECT n.inode AS inode FROM vfs_nodes n JOIN vfs_dirents d1 ON d1.child_inode=n.inode WHERE d1.name='blob.bin'",
    );
    const chunks = ws.db.all<{ size: number }>(
      "SELECT size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
      // biome-ignore lint/style/noNonNullAssertion: query must succeed in this test
      inodeRow!.inode,
    );
    const sum = chunks.reduce((s, c) => s + c.size, 0);
    expect(sum).toBe(total);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.size).toBeLessThanOrEqual(512 * 1024);
    }
  });

  it("leaves indexed=0 and an empty subtree when materialize() throws", async () => {
    const storage = makeStorage();
    const mount = fakeMount({
      files: [
        { path: "/workspace/m/a.txt", bytes: utf8("a") },
        { path: "/workspace/m/b.txt", bytes: utf8("b") },
      ],
      throwAfter: 1,
    });
    const ws = new Workspace({
      storage,
      backends,
      mounts: { "/workspace/m": mount },
    });
    await expect(ws.ensureMountsIndexed()).rejects.toThrow(/boom/);

    const persisted = ws.db.one<{ indexed: number }>(
      "SELECT indexed FROM _vfs_mounts WHERE root = ?",
      "/workspace/m",
    );
    expect(persisted?.indexed ?? 0).toBe(0);
    // The mount root and everything under it is rolled back via
    // rm(root, { recursive, force }), so the root itself no longer
    // resolves — readdir() throws ENOENT. This is stricter than
    // a name-spot-check: it asserts the whole subtree is gone, not
    // just the two files we happened to know about.
    await expect(ws.fs.readdir("/workspace/m")).rejects.toMatchObject({ code: "ENOENT" });

    // Second attempt: replace the mount with a clean one and run
    // again. The next pass should call materialize() again because
    // the previous run is still indexed=0.
    const recover = fakeMount({
      files: [{ path: "/workspace/m/a.txt", bytes: utf8("ok") }],
    });
    const ws2 = new Workspace({
      storage,
      backends,
      mounts: { "/workspace/m": recover },
    });
    await ws2.ensureMountsIndexed();
    expect(recover.calls).toBe(1);
    expect(new TextDecoder().decode(await readAll(ws2, "/workspace/m/a.txt"))).toBe("ok");
  });

  it("throws when materialize exceeds maxBytes and leaves vfs_nodes empty", async () => {
    const mount: EagerMount = {
      kind: "huge",
      mode: "read-only",
      strategy: "eager",
      maxBytes: 100,
      async materialize(api) {
        await api.writeFile("/workspace/cap/big.bin", streamOf(new Uint8Array(1024)));
      },
    };
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/cap": mount },
    });
    await expect(ws.ensureMountsIndexed()).rejects.toThrow(/maxBytes|byte/i);
    const inode = ws.db.one("SELECT inode FROM vfs_nodes WHERE manifest_hash IS NOT NULL");
    expect(inode).toBeUndefined();
  });

  it("throws when maxEntries is exceeded and rolls back the subtree", async () => {
    const mount: EagerMount = {
      kind: "capped",
      mode: "read-only",
      strategy: "eager",
      maxEntries: 2,
      async materialize(api) {
        await api.writeFile("/workspace/cap/a.txt", streamOf(utf8("a")));
        await api.writeFile("/workspace/cap/b.txt", streamOf(utf8("b")));
        await api.writeFile("/workspace/cap/c.txt", streamOf(utf8("c")));
      },
    };
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/cap": mount },
    });
    await expect(ws.ensureMountsIndexed()).rejects.toThrow(/maxEntries/);
    const persisted = ws.db.one<{ indexed: number }>(
      "SELECT indexed FROM _vfs_mounts WHERE root = ?",
      "/workspace/cap",
    );
    expect(persisted?.indexed ?? 0).toBe(0);
    await expect(ws.fs.readdir("/workspace/cap")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("materialize() throws when writeFile targets a path outside the mount root", async () => {
    const mount: EagerMount = {
      kind: "escapes",
      mode: "read-only",
      strategy: "eager",
      async materialize(api) {
        await api.writeFile("/other/place.txt", streamOf(utf8("nope")));
      },
    };
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/m": mount },
    });
    await expect(ws.ensureMountsIndexed()).rejects.toThrow(/outside the mount root/);
    // Neither the mount root nor the escape target should have left
    // anything behind in vfs_nodes.
    await expect(ws.fs.readdir("/workspace/m")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(ws.fs.readdir("/other")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ready() triggers ensureMountsIndexed before resolving", async () => {
    // Wire a no-op SyncRPC just rich enough for #connect() to
    // succeed and reconcileWatermarks() to find what it needs.
    // Mirrors the fakeRpc() pattern from workspace.test.ts.
    const sync: import("@cloudflare/workspace-rpc").SyncRPC = {
      async push(input) {
        const reader = input.changes.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
        return { rev: 0, appliedPushCursor: { rev: input.senderRev, path: null } };
      },
      async fetchChanges() {
        return {
          currentCursor: { rev: 0, path: null },
          appliedPushCursor: { rev: 0, path: null },
          stream: new ReadableStream<import("@cloudflare/dofs").ChangeEntry>({
            start(c) {
              c.close();
            },
          }),
        };
      },
      async readEntry() {
        return null;
      },
      async hasObjects() {
        return [];
      },
      fetchObjects() {
        return new ReadableStream({
          start(c) {
            c.close();
          },
        });
      },
      async watermarks() {
        return { currentRev: 0, pushRev: 0, fetchCursor: { rev: 0, path: null } };
      },
      async pushObjects(objects) {
        const reader = objects.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
    const notWired = () => Promise.reject(new Error("shell not wired"));
    const shell: import("@cloudflare/workspace-rpc").ShellRPC = {
      exec: notWired,
      getExec: notWired,
      killExec: notWired,
      disposeExec: notWired,
    };
    const backend: WorkspaceBackend = {
      id: "test",
      async connect(): Promise<BackendHandle> {
        return { rpc: { sync, shell }, close: async () => {} };
      },
    };
    const materializeSpy = vi.fn(async (api: MountWriteAPI) => {
      await api.writeFile("/workspace/r/hello.txt", streamOf(utf8("hi")));
    });
    const mount: EagerMount = {
      kind: "ready-test",
      mode: "read-only",
      strategy: "eager",
      materialize: materializeSpy,
    };
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [backend],
      mounts: { "/workspace/r": mount },
    });
    // The contract: ready() must drive ensureMountsIndexed() before
    // resolving. So reading a mounted path immediately after ready()
    // (without an explicit ensureMountsIndexed call) must succeed.
    await ws.ready();
    expect(materializeSpy).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(await readAll(ws, "/workspace/r/hello.txt"))).toBe("hi");
    // A second ready() is idempotent: no extra materialize() call.
    await ws.ready();
    expect(materializeSpy).toHaveBeenCalledTimes(1);
    await ws.close();
  });

  it("collapses concurrent ensureMountsIndexed() calls to one materialize", async () => {
    let entered = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mount: EagerMount = {
      kind: "slow",
      mode: "read-only",
      strategy: "eager",
      async materialize(api) {
        entered += 1;
        await gate;
        await api.writeFile("/workspace/s/f.txt", streamOf(utf8("ok")));
      },
    };
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/s": mount },
    });
    const a = ws.ensureMountsIndexed();
    const b = ws.ensureMountsIndexed();
    // biome-ignore lint/style/noNonNullAssertion: release is set inside the gate promise
    release!();
    await Promise.all([a, b]);
    expect(entered).toBe(1);
  });
});
