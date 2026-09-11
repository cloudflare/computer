import {
  Database,
  initializeSchema,
  readOperation,
  readPushCursor,
  SQLiteWorkspaceProvider,
} from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import type { SyncRPC } from "./interface.js";
import { createSyncServer } from "./server.js";
import { pushBlocks, type SyncProgress } from "./sync-engine.js";

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

        await expect(pushOneBlock(local.db, lossy, {})).rejects.toThrow();
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
});
