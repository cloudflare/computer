import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  assertAppliedPushCursor,
  type ChangeEntry,
  coalesceChanges,
  Database,
  fetchObjects,
  initializeSchema,
  ROOT_INODE,
  readFetchCursor,
  SQLiteWorkspaceProvider,
  writeFetchCursor,
} from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { createSyncClient } from "../src/client.js";
import { acceptWebSocketSession, createSyncServer } from "../src/server.js";

interface Harness {
  url: string;
  db: Database;
  close: () => Promise<void>;
}

// Stand up a real HTTP + WebSocket server bound to 127.0.0.1, with a
// fresh in-memory SQLite-backed VFS behind a SyncRPC adapter. Returns
// the ws:// URL the client should dial. Each test calls
// teardown via `await harness.close()` in afterEach.
async function startHarness(): Promise<Harness> {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => 1000);
  const rpc = createSyncServer(db);
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http, path: "/rpc" });
  wss.on("connection", (ws) => {
    acceptWebSocketSession(ws, rpc);
  });
  await new Promise<void>((res) => http.listen(0, "127.0.0.1", res));
  const { port } = http.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/rpc`,
    db,
    close: async () => {
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
      storage.close();
    },
  };
}

describe("SyncRPC over a real WebSocket", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("streams fetchChanges entries from server to client", async () => {
    harness = await startHarness();
    const provider = new SQLiteWorkspaceProvider(harness.db, { now: () => 1234 });
    provider.writeFileSync("/hello.txt", "hello");

    const client = createSyncClient({ url: harness.url });
    try {
      const { stream } = await client.fetchChanges({ after: { rev: 0, path: null }, ignore: [] });
      const entries: ChangeEntry[] = [];
      const reader = stream.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          entries.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const file = entries.find((e) => e.path === "/hello.txt");
      expect(file).toBeDefined();
      expect(file?.kind).toBe("file");
      if (file?.kind === "file") {
        expect(file.size).toBe(5);
        expect(file.mtime).toBe(1234);
      }
    } finally {
      await client.close();
    }
  });
});

describe("SyncRPC.readEntry over a real WebSocket", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("returns the entry for a path that exists", async () => {
    harness = await startHarness();
    const provider = new SQLiteWorkspaceProvider(harness.db, { now: () => 1234 });
    provider.writeFileSync("/probe.txt", "data");

    const client = createSyncClient({ url: harness.url });
    try {
      const entry = await client.readEntry("/probe.txt");
      expect(entry).not.toBeNull();
      expect(entry?.path).toBe("/probe.txt");
      expect(entry?.kind).toBe("file");
      if (entry?.kind === "file") expect(entry.size).toBe(4);
    } finally {
      await client.close();
    }
  });

  it("returns null over the wire for a missing path", async () => {
    // SyncRPC.readEntry's documented contract is to resolve with
    // null when the path doesn't exist. The local stat() path
    // throws ENOENT; readEntry intentionally does not, because
    // it's a probe used by the sync loop to decide whether to
    // pull bytes. Pin the null behaviour over the wire.
    harness = await startHarness();
    const client = createSyncClient({ url: harness.url });
    try {
      const entry = await client.readEntry("/missing.txt");
      expect(entry).toBeNull();
    } finally {
      await client.close();
    }
  });
});

describe("SyncRPC push convergence", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("client pushes ChangeEntry + bytes; server converges", async () => {
    // Two DBs: A holds the pre-populated state, B is the receiver
    // we connect to over the wire. The client collects A's changes
    // and pushes them to B via push() + pushObjects().
    const senderStorage = new SQLiteTestStorage();
    const senderDb = new Database(senderStorage);
    initializeSchema(senderDb, () => 1000);
    const senderProvider = new SQLiteWorkspaceProvider(senderDb, { now: () => 1500 });
    senderProvider.writeFileSync("/a.txt", "alpha");
    senderProvider.writeFileSync("/b.txt", "beta");

    try {
      harness = await startHarness();
      const client = createSyncClient({ url: harness.url });
      try {
        // Stage every chunk the sender has into the server first,
        // then push the change list.
        const entries: ChangeEntry[] = [];
        const hashes: Uint8Array[] = [];
        const seenHash = new Set<string>();
        for await (const e of coalesceChanges(senderDb, { rev: 0, path: null })) {
          entries.push(e);
          if (e.kind === "file") {
            for (const c of e.chunks) {
              const k = Array.from(c.hash).join(",");
              if (!seenHash.has(k)) {
                seenHash.add(k);
                hashes.push(c.hash);
              }
            }
          }
        }
        // Stream bytes to the server.
        const objects = new ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>({
          async start(controller) {
            for await (const { hash, bytes } of fetchObjects(senderDb, hashes)) {
              controller.enqueue({ hash, bytes });
            }
            controller.close();
          },
        });
        await client.pushObjects(objects);

        // Push the entries. The server's push() drains the stream
        // and applies under transactionSync.
        const changes = new ReadableStream<ChangeEntry>({
          start(controller) {
            for (const e of entries) controller.enqueue(e);
            controller.close();
          },
        });
        // Use senderDb's currentRev as senderRev — we're
        // simulating a sync peer, not an external orchestrator.
        const { currentRev } = await import("@cloudflare/dofs");
        const result = await client.push({ senderRev: currentRev(senderDb), changes });
        expect(result.rev).toBeGreaterThan(0);

        // Inspect the server DB directly through the harness handle.
        const a = harness.db.one<{ child_inode: number }>(
          "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
          ROOT_INODE,
          "a.txt",
        );
        expect(a?.child_inode).toBeGreaterThan(0);
        const b = harness.db.one<{ child_inode: number }>(
          "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
          ROOT_INODE,
          "b.txt",
        );
        expect(b?.child_inode).toBeGreaterThan(0);
      } finally {
        await client.close();
      }
    } finally {
      senderStorage.close();
    }
  });
});

describe("SyncRPC pull convergence", () => {
  // Reproduces the FUSE → RPC direction observed broken in the
  // production container example: an exec'd command writes a
  // file through FUSE on the computerd side, and the host's
  // pullOnce(b, computerdRpc) is supposed to bring the bytes back. The
  // bug surfaced as HTTP 200 / 0 bytes on the subsequent RPC read,
  // suggesting the dirent transferred but the chunks didn't.
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("client pulls a file written via writeFileSync on the server", async () => {
    harness = await startHarness();
    const provider = new SQLiteWorkspaceProvider(harness.db, { now: () => 1500 });
    provider.writeFileSync("/whole.txt", "whole-file write");

    // Receiver DB — the host's local store in the production setup.
    const recvStorage = new SQLiteTestStorage();
    const recvDb = new Database(recvStorage);
    initializeSchema(recvDb, () => 2000);

    const client = createSyncClient({ url: harness.url });
    try {
      const { pullOnce } = await import("../src/sync-driver.js");
      const applied = await pullOnce(recvDb, client);
      expect(applied.applied).toBeGreaterThan(0);
      const recvProvider = new SQLiteWorkspaceProvider(recvDb, { now: () => 2500 });
      expect(recvProvider.readFileSync("/whole.txt", "utf8")).toBe("whole-file write");
    } finally {
      await client.close();
      recvStorage.close();
    }
  });

  it("client pulls a file written via the fd table (FUSE-shaped writeSync)", async () => {
    // Mirror the production scenario: openSync + writeSync +
    // closeSync rather than the whole-file writeFileSync. FUSE's
    // backing platformatic/vfs adapter drives the provider through
    // this path. If the bytes don't make it across, this is where
    // the production HTTP 200 / 0 bytes shape reproduces.
    harness = await startHarness();
    const provider = new SQLiteWorkspaceProvider(harness.db, { now: () => 1500 });
    const fd = provider.openSync("/from-fuse.txt", "w");
    const payload = Buffer.from("from-fuse\n", "utf8");
    provider.writeSync(fd, payload, 0, payload.byteLength, null);
    provider.closeSync(fd);

    const recvStorage = new SQLiteTestStorage();
    const recvDb = new Database(recvStorage);
    initializeSchema(recvDb, () => 2000);

    const client = createSyncClient({ url: harness.url });
    try {
      const { pullOnce } = await import("../src/sync-driver.js");
      const applied = await pullOnce(recvDb, client);
      expect(applied.applied).toBeGreaterThan(0);
      const recvProvider = new SQLiteWorkspaceProvider(recvDb, { now: () => 2500 });
      expect(recvProvider.readFileSync("/from-fuse.txt", "utf8")).toBe("from-fuse\n");
    } finally {
      await client.close();
      recvStorage.close();
    }
  });
});

import { createWorkspaceError } from "@cloudflare/dofs";

describe("WireError propagation", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("propagates the error message across the wire for an unknown hash", async () => {
    // fetchObjects() throws when asked for a hash the server
    // doesn't hold. The bytes never made it into vfs_blob_bytes,
    // so the server-side helper throws WorkspaceFsError with
    // code='EUNKNOWN_HASH'. We surface the original message and
    // assert err.code survives the round trip so application code
    // can branch on it without parsing the message.
    harness = await startHarness();
    const client = createSyncClient({ url: harness.url });
    try {
      const unknown = new Uint8Array(32);
      unknown.fill(0xff);
      const stream = await client.fetchObjects([unknown]);
      const reader = stream.getReader();
      let caught: unknown;
      try {
        await reader.read();
      } catch (e) {
        caught = e;
      } finally {
        reader.releaseLock();
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/missing/i);
      expect((caught as { code?: string }).code).toBe("EUNKNOWN_HASH");
    } finally {
      await client.close();
    }
  });

  it("propagates own enumerable error properties (e.g. code) over the wire", async () => {
    // Wire a custom server that throws a WorkspaceFsError so we
    // can observe the props bag round-trip. We don't need the
    // Database for this; an inline RpcTarget is enough.
    const { RpcTarget, newWebSocketRpcSession } = await import("capnweb");
    const http = createServer();
    const wss = new WebSocketServer({ server: http, path: "/rpc" });
    class Bad extends RpcTarget {
      boom() {
        throw createWorkspaceError("ENOENT", "no such file", "/missing");
      }
    }
    wss.on("connection", (ws) => {
      newWebSocketRpcSession(ws, new Bad());
    });
    await new Promise<void>((res) => http.listen(0, "127.0.0.1", res));
    const port = (http.address() as { port: number }).port;
    const stub = newWebSocketRpcSession(`ws://127.0.0.1:${port}/rpc`) as unknown as {
      boom(): Promise<void>;
      [Symbol.dispose]?(): void;
    };
    let caught: unknown;
    try {
      await stub.boom();
    } catch (e) {
      caught = e;
    } finally {
      stub[Symbol.dispose]?.();
      // Force a brutal teardown so we don't depend on the
      // capnweb session draining cleanly to exit the test.
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
    }
    expect((caught as { code?: string })?.code).toBe("ENOENT");
    expect((caught as Error).message).toMatch(/no such file/);
  });
});

describe("cross-side invariant", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("push returns an appliedPushCursor that covers senderRev", async () => {
    harness = await startHarness();
    const client = createSyncClient({ url: harness.url });
    try {
      const empty = new ReadableStream<ChangeEntry>({
        start(c) {
          c.close();
        },
      });
      const result = await client.push({ senderRev: 0, changes: empty });
      expect(result.appliedPushCursor).toEqual({ rev: 0, path: null });
      // The durable object would pass result.appliedPushCursor as
      // `applied` and its own push cursor as `pushed`. With both at
      // zero, the invariant holds.
      expect(() =>
        assertAppliedPushCursor(result.appliedPushCursor, { rev: 0, path: null }),
      ).not.toThrow();
    } finally {
      await client.close();
    }
  });
});

import type { RPCEvent } from "../src/client.js";

describe("onRPCEvent observability", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("fires once per RPC with ok=true on success", async () => {
    harness = await startHarness();
    const events: RPCEvent[] = [];
    const client = createSyncClient({
      url: harness.url,
      onRPCEvent: (e) => events.push(e),
    });
    try {
      await client.hasObjects([]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ rpc: "hasObjects", ok: true });
      expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await client.close();
    }
  });
});

describe("client lifecycle", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("close() is idempotent", async () => {
    harness = await startHarness();
    const client = createSyncClient({ url: harness.url });
    await client.close();
    // Second close() must not throw or hang.
    await client.close();
  });

  it("a call after close() rejects rather than hanging", async () => {
    harness = await startHarness();
    const client = createSyncClient({ url: harness.url });
    await client.close();
    let caught: unknown;
    try {
      await client.hasObjects([]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});

describe("push semantics — external vs sync peer", () => {
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("push with senderRev=0 (external orchestrator) leaves pushRev alone so the outbound sync loop can ship the entry", async () => {
    harness = await startHarness();
    const { coalesceChanges, currentRev, readWatermark } = await import("@cloudflare/dofs");
    const client = createSyncClient({ url: harness.url });
    try {
      // Stage one chunk + push one entry as if we were an
      // external writer (no rev space of our own).
      const bytes = new TextEncoder().encode("external write");
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      await client.pushObjects(
        new ReadableStream({
          start(c) {
            c.enqueue({ hash, bytes });
            c.close();
          },
        }),
      );
      await client.push({
        senderRev: 0,
        changes: new ReadableStream({
          start(c) {
            c.enqueue({
              kind: "file",
              rev: 1,
              path: "/external.txt",
              mode: 0o644,
              mtime: 100,
              size: bytes.byteLength,
              chunks: [{ hash, size: bytes.byteLength }],
            });
            c.close();
          },
        }),
      });

      // The push landed: currentRev bumped past 1.
      expect(currentRev(harness.db)).toBeGreaterThan(1);
      // pushRev was NOT advanced. Anything driving the
      // outbound sync loop (a computerd with UPSTREAM_URL set) would
      // see the new entry on the next tick.
      expect(readWatermark(harness.db, "pushRev")).toBe(0);
      // The fetch cursor was NOT advanced either — the sender has
      // no rev space.
      expect(readFetchCursor(harness.db)).toEqual({ rev: 0, path: null });
      // The entry is in the coalesce stream.
      const drained: { path: string }[] = [];
      for await (const e of coalesceChanges(harness.db, { rev: 0, path: null })) drained.push(e);
      expect(drained.some((e) => e.path === "/external.txt")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("push with senderRev>0 (sync peer) leaves pushRev for the next push, advances fetchRev to senderRev", async () => {
    harness = await startHarness();
    const { currentRev, readFetchCursor, readWatermark, writeWatermark } = await import(
      "@cloudflare/dofs"
    );
    const client = createSyncClient({ url: harness.url });
    try {
      // Seed pushRev at the current point so the F1 guard
      // is satisfied: with no unpushed local writes, the
      // suppression is free to advance pushRev past the
      // apply's own rev bumps.
      writeWatermark(harness.db, "pushRev", currentRev(harness.db));
      const bytes = new TextEncoder().encode("from peer");
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      await client.pushObjects(
        new ReadableStream({
          start(c) {
            c.enqueue({ hash, bytes });
            c.close();
          },
        }),
      );
      await client.push({
        senderRev: 42, // pretend we're a peer at rev 42
        changes: new ReadableStream({
          start(c) {
            c.enqueue({
              kind: "file",
              rev: 1,
              path: "/from-peer.txt",
              mode: 0o644,
              mtime: 100,
              size: bytes.byteLength,
              chunks: [{ hash, size: bytes.byteLength }],
            });
            c.close();
          },
        }),
      });

      // pushRev stays where we seeded it: the receiver does
      // not advance pushRev locally on upstream apply (that was
      // unsound — it desynced pushRev from the wire-visible
      // fetch cursor and broke the cross-side invariant on the
      // next pull). The next pushOnce ships the apply's rev
      // bumps and alreadyApplied() drops them.
      expect(readWatermark(harness.db, "pushRev")).toBe(1);
      // The fetch cursor was advanced to senderRev.
      expect(readFetchCursor(harness.db)).toEqual({ rev: 42, path: null });
    } finally {
      await client.close();
    }
  });

  it("push with senderRev>0 advances the fetch cursor monotonically", async () => {
    harness = await startHarness();
    const client = createSyncClient({ url: harness.url });
    try {
      writeFetchCursor(harness.db, { rev: 10, path: "/partial.txt" });
      await client.push({
        senderRev: 10,
        changes: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      });
      expect(readFetchCursor(harness.db)).toEqual({ rev: 10, path: null });

      await client.push({
        senderRev: 3,
        changes: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      });
      expect(readFetchCursor(harness.db)).toEqual({ rev: 10, path: null });
    } finally {
      await client.close();
    }
  });
});
