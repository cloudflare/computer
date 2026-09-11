import {
  Database,
  initializeSchema,
  readOperation,
  SQLiteWorkspaceProvider,
} from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import type { SyncRPC } from "./interface.js";
import { createSyncServer } from "./server.js";
import { pullBlocks, pushBlocks, type SyncProgress } from "./sync-engine.js";

// Pack mode is the bulk path. These tests force the mode thresholds
// down rather than materialising 20,000 files, then assert the two
// things that distinguish pack from entry mode: the transport actually
// used a pack, and convergence is identical either way.

function makePeer(): { db: Database; rpc: SyncRPC; close: () => void } {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => 1000);
  const rpc = createSyncServer(db);
  return { db, rpc, close: () => storage.close() };
}

function seed(db: Database, count: number, bytes = 16): void {
  const provider = new SQLiteWorkspaceProvider(db);
  for (let i = 0; i < count; i++) {
    const filler = String.fromCharCode(97 + (i % 26)).repeat(Math.max(1, bytes - 1));
    provider.writeFileSync(`/f${String(i).padStart(3, "0")}.txt`, `${i}${filler}`);
  }
}

function names(db: Database): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM vfs_dirents WHERE parent_inode = 1 ORDER BY name")
    .map((r) => r.name);
}

// Force pack selection at a low entry count.
const PACK_OPTIONS = { thresholdEntries: 3, thresholdBytes: 1024 * 1024 * 1024 };

async function drain(iterable: AsyncIterable<SyncProgress>, limit = 200): Promise<SyncProgress[]> {
  const seen: SyncProgress[] = [];
  for await (const progress of iterable) {
    seen.push(progress);
    if (seen.length > limit) throw new Error("sync did not terminate");
  }
  return seen;
}

describe("pack mode pull", () => {
  it("selects pack mode once the window crosses the entry threshold", async () => {
    const local = makePeer();
    const remote = makePeer();
    try {
      seed(remote.db, 6);

      const seen = await drain(pullBlocks(local.db, remote.rpc, PACK_OPTIONS));

      expect(seen[0].mode).toBe("pack");
      expect(seen[seen.length - 1].complete).toBe(true);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("stays in entry mode below the threshold", async () => {
    const local = makePeer();
    const remote = makePeer();
    try {
      seed(remote.db, 2);

      const seen = await drain(pullBlocks(local.db, remote.rpc, PACK_OPTIONS));

      expect(seen[0].mode).toBe("entries");
    } finally {
      local.close();
      remote.close();
    }
  });

  it("converges through a pack exactly as entry mode would", async () => {
    const local = makePeer();
    const remote = makePeer();
    try {
      seed(remote.db, 6);

      await drain(pullBlocks(local.db, remote.rpc, PACK_OPTIONS));

      expect(names(local.db)).toEqual([
        "f000.txt",
        "f001.txt",
        "f002.txt",
        "f003.txt",
        "f004.txt",
        "f005.txt",
      ]);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("transfers file content through the pack", async () => {
    const local = makePeer();
    const remote = makePeer();
    try {
      seed(remote.db, 5);

      await drain(pullBlocks(local.db, remote.rpc, PACK_OPTIONS));

      const provider = new SQLiteWorkspaceProvider(local.db);
      expect(provider.readFileSync("/f000.txt", "utf8")).toBe(`0${"a".repeat(15)}`);
      expect(provider.readFileSync("/f004.txt", "utf8")).toBe(`4${"e".repeat(15)}`);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("splits a pack operation across blocks and still converges", async () => {
    const local = makePeer();
    const remote = makePeer();
    try {
      seed(remote.db, 8);

      const seen = await drain(
        pullBlocks(local.db, remote.rpc, {
          ...PACK_OPTIONS,
          profile: { maxEntries: 3, maxBytes: 64 * 1024 * 1024 },
        }),
      );

      expect(seen.length).toBeGreaterThanOrEqual(3);
      expect(seen.every((p) => p.mode === "pack")).toBe(true);
      expect(names(local.db)).toHaveLength(8);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("resumes a pack operation in a fresh iterable after every block", async () => {
    const local = makePeer();
    const remote = makePeer();
    try {
      seed(remote.db, 8);
      const options = {
        ...PACK_OPTIONS,
        profile: { maxEntries: 3, maxBytes: 64 * 1024 * 1024 },
      };

      for (let i = 0; i < 20; i++) {
        const iterator = pullBlocks(local.db, remote.rpc, options)[Symbol.asyncIterator]();
        const { value, done } = await iterator.next();
        if (done || value.complete) break;
      }

      expect(names(local.db)).toHaveLength(8);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("keeps the mode fixed for the life of an operation", async () => {
    const local = makePeer();
    const remote = makePeer();
    try {
      seed(remote.db, 8);
      const options = {
        ...PACK_OPTIONS,
        profile: { maxEntries: 3, maxBytes: 64 * 1024 * 1024 },
      };

      const iterator = pullBlocks(local.db, remote.rpc, options)[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value.mode).toBe("pack");
      // The persisted operation records the mode, so a resumed
      // iterator cannot silently switch encodings mid-operation.
      expect(readOperation(local.db, "default", "pull")?.mode).toBe("pack");
    } finally {
      local.close();
      remote.close();
    }
  });

  it("deduplicates shared content across the pack", async () => {
    const local = makePeer();
    const remote = makePeer();
    try {
      const provider = new SQLiteWorkspaceProvider(remote.db);
      for (let i = 0; i < 6; i++) {
        provider.writeFileSync(`/same${i}.txt`, "identical content everywhere");
      }

      await drain(pullBlocks(local.db, remote.rpc, PACK_OPTIONS));

      expect(names(local.db)).toHaveLength(6);
      // One unique object backs all six paths.
      const blobs = local.db.one<{ c: number }>("SELECT COUNT(*) AS c FROM vfs_blobs")?.c ?? 0;
      expect(blobs).toBe(1);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("applies deletions carried in a pack", async () => {
    const local = makePeer();
    const remote = makePeer();
    try {
      seed(remote.db, 6);
      await drain(pullBlocks(local.db, remote.rpc, PACK_OPTIONS));

      const provider = new SQLiteWorkspaceProvider(remote.db);
      provider.unlinkSync("/f000.txt");
      provider.unlinkSync("/f001.txt");
      provider.unlinkSync("/f002.txt");
      provider.unlinkSync("/f003.txt");
      await drain(pullBlocks(local.db, remote.rpc, PACK_OPTIONS));

      expect(names(local.db)).toEqual(["f004.txt", "f005.txt"]);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("surfaces a corrupt pack as a protocol error without advancing", async () => {
    const local = makePeer();
    const remote = makePeer();
    try {
      seed(remote.db, 6);

      // Truncate the pack stream mid-flight.
      const corrupting = new Proxy(remote.rpc as object, {
        get(target, prop, receiver) {
          if (prop === "fetchChangePack") {
            return async (...args: unknown[]) => {
              const real = (await (
                Reflect.get(target, prop, receiver) as (...a: unknown[]) => Promise<{
                  stream: ReadableStream<Uint8Array>;
                  cursor: unknown;
                }>
              ).call(target, ...args)) as { stream: ReadableStream<Uint8Array>; cursor: unknown };
              const reader = real.stream.getReader();
              const truncated = new ReadableStream<Uint8Array>({
                async pull(controller) {
                  const { value, done } = await reader.read();
                  if (done) {
                    controller.close();
                    return;
                  }
                  // Emit a mangled first chunk and stop.
                  const broken = new Uint8Array(value.slice(0, Math.max(1, value.length >> 1)));
                  controller.enqueue(broken);
                  controller.close();
                },
              });
              return { ...real, stream: truncated };
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as SyncRPC;

      const iterator = pullBlocks(local.db, corrupting, PACK_OPTIONS)[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toThrow(/pack/i);

      // Nothing applied, cursor untouched.
      expect(names(local.db)).toEqual([]);
    } finally {
      local.close();
      remote.close();
    }
  });
});

describe("pack mode push", () => {
  it("ships a large local window as a pack and converges", async () => {
    const local = makePeer();
    const remote = makePeer();
    try {
      seed(local.db, 6);

      const seen = await drain(pushBlocks(local.db, remote.rpc, PACK_OPTIONS));

      expect(seen[0].mode).toBe("pack");
      expect(names(remote.db)).toHaveLength(6);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("transfers content correctly through a pushed pack", async () => {
    const local = makePeer();
    const remote = makePeer();
    try {
      seed(local.db, 5);

      await drain(pushBlocks(local.db, remote.rpc, PACK_OPTIONS));

      const provider = new SQLiteWorkspaceProvider(remote.db);
      expect(provider.readFileSync("/f003.txt", "utf8")).toBe(`3${"d".repeat(15)}`);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("resumes a pushed pack across blocks", async () => {
    const local = makePeer();
    const remote = makePeer();
    try {
      seed(local.db, 8);
      const options = {
        ...PACK_OPTIONS,
        profile: { maxEntries: 3, maxBytes: 64 * 1024 * 1024 },
      };

      for (let i = 0; i < 20; i++) {
        const iterator = pushBlocks(local.db, remote.rpc, options)[Symbol.asyncIterator]();
        const { value, done } = await iterator.next();
        if (done || value.complete) break;
      }

      expect(names(remote.db)).toHaveLength(8);
    } finally {
      local.close();
      remote.close();
    }
  });

  // A pre-command push carries exactly the large window that selects
  // pack mode, and on a shim backend the spawned command reads from
  // disk rather than the VFS. If the pack receiver skips the settle
  // hook the command sees stale contents, so the hook has to fire on
  // both transports.
  it("settles the receiver's shim after a pack push", async () => {
    const local = makePeer();
    const storage = new SQLiteTestStorage();
    const remoteDb = new Database(storage);
    initializeSchema(remoteDb, () => 1000);
    let calls = 0;
    let namesAtHook: string[] = [];
    const remoteRpc = createSyncServer(remoteDb, {
      afterApply: () => {
        calls += 1;
        namesAtHook = names(remoteDb);
      },
    });
    try {
      seed(local.db, 8);
      await drain(pushBlocks(local.db, remoteRpc, PACK_OPTIONS));

      expect(calls).toBeGreaterThan(0);
      // The entries must already be committed when the hook runs,
      // mirroring the entry-mode guarantee.
      expect(namesAtHook.length).toBeGreaterThan(0);
      expect(names(remoteDb)).toHaveLength(8);
    } finally {
      local.close();
      storage.close();
    }
  });

  it("fails a pack push whose settle rejects, leaving the block unretired", async () => {
    const local = makePeer();
    const storage = new SQLiteTestStorage();
    const remoteDb = new Database(storage);
    initializeSchema(remoteDb, () => 1000);
    let fail = true;
    const remoteRpc = createSyncServer(remoteDb, {
      afterApply: () => {
        if (fail) throw new Error("disk full");
      },
    });
    try {
      seed(local.db, 8);
      // The sender advances its cursor on the acknowledgment and the
      // caller spawns a command on it, so an unflushed pack must not
      // acknowledge.
      await expect(drain(pushBlocks(local.db, remoteRpc, PACK_OPTIONS))).rejects.toThrow(
        "disk full",
      );

      // Once the shim recovers the same block replays and completes.
      fail = false;
      await drain(pushBlocks(local.db, remoteRpc, PACK_OPTIONS));
      expect(names(remoteDb)).toHaveLength(8);
    } finally {
      local.close();
      storage.close();
    }
  });

  it("does not settle the shim when a pack push carries no entries", async () => {
    const local = makePeer();
    const storage = new SQLiteTestStorage();
    const remoteDb = new Database(storage);
    initializeSchema(remoteDb, () => 1000);
    let calls = 0;
    const remoteRpc = createSyncServer(remoteDb, {
      afterApply: () => {
        calls += 1;
      },
    });
    try {
      // Nothing written locally, so no block carries entries.
      await drain(pushBlocks(local.db, remoteRpc, PACK_OPTIONS));
      expect(calls).toBe(0);
    } finally {
      local.close();
      storage.close();
    }
  });
});
