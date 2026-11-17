import { createHash } from "node:crypto";

import {
  Database,
  initializeSchema,
  readOperation,
  readPushCursor,
  SQLiteWorkspaceProvider,
} from "@cloudflare/dofs";
import { isPinned, SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import type { SyncRPC } from "./interface";
import { createSyncServer } from "./server";
import { pushBlocks, type SyncProgress } from "./sync-engine";

// Push runs the same operation and block machinery as pull, in the
// other direction. The property that distinguishes it: the local
// cursor may only advance through a remote acknowledgment. A push that
// advanced its cursor optimistically would silently drop data whenever
// an acknowledgment was lost.

function makePeer(): { db: Database; rpc: SyncRPC; close: () => void } {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => 1000);
  const rpc = createSyncServer(db);
  return { db, rpc, close: () => storage.close() };
}

function seedLocal(db: Database, count: number): void {
  const provider = new SQLiteWorkspaceProvider(db);
  for (let i = 0; i < count; i++) {
    provider.writeFileSync(`/f${String(i).padStart(3, "0")}.txt`, `content-${i}`);
  }
}

function remoteNames(db: Database): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM vfs_dirents WHERE parent_inode = 1 ORDER BY name")
    .map((r) => r.name);
}

async function pushOneBlock(
  db: Database,
  rpc: SyncRPC,
  options: Parameters<typeof pushBlocks>[2] = {},
): Promise<SyncProgress | undefined> {
  const iterator = pushBlocks(db, rpc, options)[Symbol.asyncIterator]();
  const { value, done } = await iterator.next();
  return done ? undefined : value;
}

async function drainPush(
  db: Database,
  rpc: SyncRPC,
  options: Parameters<typeof pushBlocks>[2] = {},
): Promise<SyncProgress[]> {
  const seen: SyncProgress[] = [];
  for await (const progress of pushBlocks(db, rpc, options)) {
    seen.push(progress);
    if (seen.length > 200) throw new Error("push did not terminate");
  }
  return seen;
}

describe("restartable push engine", () => {
  describe("completion contract", () => {
    it("yields a single complete value for an empty window", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        const seen = await drainPush(local.db, remote.rpc);

        expect(seen).toHaveLength(1);
        expect(seen[0].complete).toBe(true);
        expect(seen[0].direction).toBe("push");
      } finally {
        local.close();
        remote.close();
      }
    });

    it("ships every local entry to the remote", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedLocal(local.db, 4);

        await drainPush(local.db, remote.rpc);

        expect(remoteNames(remote.db)).toEqual(["f000.txt", "f001.txt", "f002.txt", "f003.txt"]);
      } finally {
        local.close();
        remote.close();
      }
    });

    it("splits a large window across blocks and still converges", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedLocal(local.db, 6);

        const seen = await drainPush(local.db, remote.rpc, {
          profile: { maxEntries: 2, maxBytes: 64 * 1024 * 1024 },
        });

        expect(seen.length).toBeGreaterThanOrEqual(3);
        expect(remoteNames(remote.db)).toHaveLength(6);
      } finally {
        local.close();
        remote.close();
      }
    });
  });

  describe("acknowledgment is the only cursor authority", () => {
    it("advances the push cursor after a successful acknowledgment", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedLocal(local.db, 3);

        const seen = await drainPush(local.db, remote.rpc);

        expect(readPushCursor(local.db)).toEqual(seen[seen.length - 1].cursor);
      } finally {
        local.close();
        remote.close();
      }
    });

    it("does not advance the cursor when the acknowledgment never arrives", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedLocal(local.db, 3);
        const before = readPushCursor(local.db);

        const failing = new Proxy(remote.rpc as object, {
          get(target, prop, receiver) {
            if (prop === "push") {
              return async () => {
                throw new Error("acknowledgment lost");
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as SyncRPC;

        await expect(pushOneBlock(local.db, failing, {})).rejects.toThrow("acknowledgment lost");

        expect(readPushCursor(local.db)).toEqual(before);
      } finally {
        local.close();
        remote.close();
      }
    });

    // A lost acknowledgment after the remote already applied means the
    // block is re-sent. The remote must absorb it rather than
    // duplicating visible state.
    it("does not duplicate remote state when a block is re-sent", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedLocal(local.db, 3);

        // First attempt: the remote applies, then the acknowledgment
        // is dropped on the way back.
        let dropped = false;
        const lossy = new Proxy(remote.rpc as object, {
          get(target, prop, receiver) {
            if (prop === "push") {
              return async (...args: unknown[]) => {
                const result = await (
                  Reflect.get(target, prop, receiver) as (...a: unknown[]) => Promise<unknown>
                ).call(target, ...args);
                if (!dropped) {
                  dropped = true;
                  throw new Error("acknowledgment lost in transit");
                }
                return result;
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as SyncRPC;

        await expect(pushOneBlock(local.db, lossy, {})).rejects.toThrow(
          "acknowledgment lost in transit",
        );
        // The retry re-sends the same block.
        await drainPush(local.db, lossy, {});

        expect(remoteNames(remote.db)).toEqual(["f000.txt", "f001.txt", "f002.txt"]);
      } finally {
        local.close();
        remote.close();
      }
    });
  });

  describe("restart from durable state", () => {
    it("resumes from the durable cursor in a new iterable", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedLocal(local.db, 5);
        const profile = { maxEntries: 2, maxBytes: 64 * 1024 * 1024 };

        await pushOneBlock(local.db, remote.rpc, { profile });
        const afterFirst = remoteNames(remote.db).length;

        await drainPush(local.db, remote.rpc, { profile });

        expect(afterFirst).toBeLessThan(5);
        expect(remoteNames(remote.db)).toHaveLength(5);
      } finally {
        local.close();
        remote.close();
      }
    });

    it("converges when the iterable is recreated after every block", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedLocal(local.db, 6);
        const profile = { maxEntries: 2, maxBytes: 64 * 1024 * 1024 };

        for (let i = 0; i < 20; i++) {
          const progress = await pushOneBlock(local.db, remote.rpc, { profile });
          if (progress?.complete) break;
        }

        expect(remoteNames(remote.db)).toHaveLength(6);
      } finally {
        local.close();
        remote.close();
      }
    });

    it("deletes the operation row on completion", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedLocal(local.db, 2);

        await drainPush(local.db, remote.rpc);

        expect(readOperation(local.db, "default", "push")).toBeUndefined();
      } finally {
        local.close();
        remote.close();
      }
    });
  });

  describe("independence", () => {
    it("keeps push and pull operations separate for one backend", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedLocal(local.db, 4);
        const profile = { maxEntries: 2, maxBytes: 64 * 1024 * 1024 };

        await pushOneBlock(local.db, remote.rpc, { profile });

        // A pending push must not be visible as a pull operation.
        expect(readOperation(local.db, "default", "push")?.direction).toBe("push");
        expect(readOperation(local.db, "default", "pull")).toBeUndefined();
      } finally {
        local.close();
        remote.close();
      }
    });

    it("keeps push cursors independent per backend", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedLocal(local.db, 2);

        await drainPush(local.db, remote.rpc, { backend: "container" });

        expect(readPushCursor(local.db, "container").rev).toBeGreaterThan(0);
        expect(readPushCursor(local.db, "worker")).toEqual({ rev: 0, path: null });
      } finally {
        local.close();
        remote.close();
      }
    });
  });
  describe("object lifetime", () => {
    it("links what the receiver reported present after it dropped its own copy", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedLocal(local.db, 1);
        const remoteFiles = new SQLiteWorkspaceProvider(remote.db);
        // The receiver already holds the content under another name.
        remoteFiles.writeFileSync("/elsewhere.txt", "content-0");

        // It says so, so the sender skips the bytes, and then it
        // overwrites its only copy before the entry arrives.
        const racing = new Proxy(remote.rpc as object, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
            if (prop !== "hasObjects" || typeof value !== "function") return value;
            return async (hashes: Uint8Array[]) => {
              const present = await (value as (h: Uint8Array[]) => Promise<Uint8Array[]>).call(
                target,
                hashes,
              );
              remoteFiles.writeFileSync("/elsewhere.txt", "overwritten");
              return present;
            };
          },
        }) as SyncRPC;

        await drainPush(local.db, racing);

        expect(remoteFiles.readFileSync("/f000.txt", "utf8")).toBe("content-0");
      } finally {
        local.close();
        remote.close();
      }
    });

    it("fails a block whose bytes vanish before the link, and the next push sends them", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedLocal(local.db, 1);
        const hash = createHash("sha256").update("content-0").digest("hex");
        // A directory sits where the file goes, and removing it takes the
        // staged bytes with it: the receiver loses them after its staged
        // check and before the link.
        new SQLiteWorkspaceProvider(remote.db).mkdirSync("/f000.txt");
        remote.db.run(
          `CREATE TRIGGER lose_bytes AFTER DELETE ON vfs_dirents WHEN OLD.name = 'f000.txt'
           BEGIN DELETE FROM vfs_blob_bytes WHERE hash = X'${hash}'; END`,
        );

        await expect(drainPush(local.db, remote.rpc)).rejects.toMatchObject({
          code: "EUNKNOWN_HASH",
        });
        expect(readPushCursor(local.db)).toEqual({ rev: 0, path: null });

        // The failed block rolled back on the receiver. The next push
        // plans it again, probes again, and lands it.
        remote.db.run("DROP TRIGGER lose_bytes");
        await drainPush(local.db, remote.rpc);

        expect(new SQLiteWorkspaceProvider(remote.db).readFileSync("/f000.txt", "utf8")).toBe(
          "content-0",
        );
      } finally {
        local.close();
        remote.close();
      }
    });

    it("sends what it planned even when a local write drops it mid-block", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedLocal(local.db, 1);
        const provider = new SQLiteWorkspaceProvider(local.db);

        // Overwrite the planned file after the receiver says what it
        // lacks and before it pulls the bytes. That drops the last
        // reference to the content the block is about to send.
        const racing = new Proxy(remote.rpc as object, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
            if (prop !== "pushObjects" || typeof value !== "function") return value;
            return (objects: ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>) => {
              provider.writeFileSync("/f000.txt", "rewritten locally");
              return (value as (o: typeof objects) => Promise<void>).call(target, objects);
            };
          },
        }) as SyncRPC;

        await drainPush(local.db, racing);

        const remoteProvider = new SQLiteWorkspaceProvider(remote.db);
        expect(remoteProvider.readFileSync("/f000.txt", "utf8")).toBe("content-0");
        // Once the block is over, the next local write reaps it.
        provider.writeFileSync("/other.txt", "x");
        expect(local.db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs")).toBe(2);
      } finally {
        local.close();
        remote.close();
      }
    });

    it("pins the objects a block sends until the block ends", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedLocal(local.db, 2);
        const sent = local.db
          .all<{ hash: Uint8Array }>("SELECT hash FROM vfs_chunks")
          .map((row) => row.hash);
        expect(sent).toHaveLength(2);

        // The sender reads object bytes lazily, while the receiver
        // pulls them. Check the pins at the moment the receiver starts.
        let pinnedWhileSending: boolean[] = [];
        const watching = new Proxy(remote.rpc as object, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
            if (prop !== "pushObjects" || typeof value !== "function") return value;
            return (objects: ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>) => {
              pinnedWhileSending = sent.map((hash) => isPinned(local.db, hash));
              return (value as (o: typeof objects) => Promise<void>).call(target, objects);
            };
          },
        }) as SyncRPC;

        await drainPush(local.db, watching);

        expect(pinnedWhileSending).toEqual([true, true]);
        expect(sent.map((hash) => isPinned(local.db, hash))).toEqual([false, false]);
        expect(remoteNames(remote.db)).toEqual(["f000.txt", "f001.txt"]);
      } finally {
        local.close();
        remote.close();
      }
    });
  });
});
