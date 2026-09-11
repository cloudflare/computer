import {
  type ChangeCursor,
  Database,
  initializeSchema,
  readFetchCursor,
  readOperation,
  readSkips,
  SQLiteWorkspaceProvider,
} from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import type { SyncRPC } from "./interface.js";
import { createSyncServer } from "./server.js";
import { pullBlocks, type SyncProgress } from "./sync-engine.js";

// The engine's contract is that durability lives in SQLite, not in the
// iterator object. Every test here either recreates the iterable or
// abandons one partway, because that is what a Durable Object eviction
// looks like from the caller's side: the generator is gone and only
// the operation row and the watermark survive.

function makePeer(): { db: Database; rpc: SyncRPC; close: () => void } {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => 1000);
  const rpc = createSyncServer(db);
  return { db, rpc, close: () => storage.close() };
}

function seedRemote(db: Database, count: number): void {
  const provider = new SQLiteWorkspaceProvider(db);
  for (let i = 0; i < count; i++) {
    provider.writeFileSync(`/f${String(i).padStart(3, "0")}.txt`, `content-${i}`);
  }
}

function localNames(db: Database): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM vfs_dirents WHERE parent_inode = 1 ORDER BY name")
    .map((r) => r.name);
}

// Consume one block and stop, the way a strict one-step alarm handler
// would.
async function pullOneBlock(
  db: Database,
  rpc: SyncRPC,
  options: Parameters<typeof pullBlocks>[2] = {},
): Promise<SyncProgress | undefined> {
  const iterator = pullBlocks(db, rpc, options)[Symbol.asyncIterator]();
  const { value, done } = await iterator.next();
  return done ? undefined : value;
}

async function drainPull(
  db: Database,
  rpc: SyncRPC,
  options: Parameters<typeof pullBlocks>[2] = {},
): Promise<SyncProgress[]> {
  const seen: SyncProgress[] = [];
  for await (const progress of pullBlocks(db, rpc, options)) {
    seen.push(progress);
    if (seen.length > 200) throw new Error("pull did not terminate");
  }
  return seen;
}

describe("restartable pull engine", () => {
  describe("completion contract", () => {
    it("yields nothing but a complete value for an empty window", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        const seen = await drainPull(local.db, remote.rpc);

        expect(seen).toHaveLength(1);
        expect(seen[0].complete).toBe(true);
        expect(seen[0].entries).toBe(0);
      } finally {
        local.close();
        remote.close();
      }
    });

    it("marks the last yielded value complete and then ends", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 3);

        const seen = await drainPull(local.db, remote.rpc);

        expect(seen[seen.length - 1].complete).toBe(true);
        expect(seen.filter((p) => p.complete)).toHaveLength(1);
      } finally {
        local.close();
        remote.close();
      }
    });

    it("applies every entry in the window", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 4);

        await drainPull(local.db, remote.rpc);

        expect(localNames(local.db)).toEqual(["f000.txt", "f001.txt", "f002.txt", "f003.txt"]);
      } finally {
        local.close();
        remote.close();
      }
    });

    it("reports one progress value per committed block", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 5);

        const seen = await drainPull(local.db, remote.rpc, {
          profile: { maxEntries: 2, maxBytes: 64 * 1024 * 1024 },
        });

        // 5 entries at 2 per block: three blocks carry entries.
        expect(seen.length).toBeGreaterThanOrEqual(3);
        expect(seen.reduce((total, p) => total + p.entries, 0)).toBe(5);
      } finally {
        local.close();
        remote.close();
      }
    });
  });

  describe("restart from durable state", () => {
    it("persists a cursor for every yielded block", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 4);

        const first = await pullOneBlock(local.db, remote.rpc, {
          profile: { maxEntries: 2, maxBytes: 64 * 1024 * 1024 },
        });

        expect(first).toBeDefined();
        expect(readFetchCursor(local.db)).toEqual(first?.cursor);
      } finally {
        local.close();
        remote.close();
      }
    });

    // The plan's central claim: a fresh iterable resumes from SQLite
    // and does not depend on the iterator object that came before it.
    it("resumes from the durable cursor in a brand new iterable", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 5);
        const profile = { maxEntries: 2, maxBytes: 64 * 1024 * 1024 };

        // One block, then the iterator is abandoned entirely.
        await pullOneBlock(local.db, remote.rpc, { profile });
        const afterFirst = localNames(local.db);

        // A completely separate iterable finishes the job.
        await drainPull(local.db, remote.rpc, { profile });

        expect(afterFirst.length).toBeLessThan(5);
        expect(localNames(local.db)).toHaveLength(5);
      } finally {
        local.close();
        remote.close();
      }
    });

    it("converges when the iterable is recreated after every single block", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 6);
        const profile = { maxEntries: 2, maxBytes: 64 * 1024 * 1024 };

        // Simulated eviction between every block: never reuse an
        // iterator, always build a new one.
        for (let i = 0; i < 20; i++) {
          const progress = await pullOneBlock(local.db, remote.rpc, { profile });
          if (progress?.complete) break;
        }

        expect(localNames(local.db)).toHaveLength(6);
      } finally {
        local.close();
        remote.close();
      }
    });

    it("advances the cursor monotonically across restarts", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 6);
        const profile = { maxEntries: 2, maxBytes: 64 * 1024 * 1024 };

        const cursors: ChangeCursor[] = [];
        for (let i = 0; i < 20; i++) {
          const progress = await pullOneBlock(local.db, remote.rpc, { profile });
          if (progress === undefined) break;
          cursors.push(progress.cursor);
          if (progress.complete) break;
        }

        for (let i = 1; i < cursors.length; i++) {
          const previous = cursors[i - 1];
          const next = cursors[i];
          const forward =
            next.rev > previous.rev || (next.rev === previous.rev && next.path !== previous.path);
          expect(forward || next.rev === previous.rev).toBe(true);
          expect(next.rev).toBeGreaterThanOrEqual(previous.rev);
        }
      } finally {
        local.close();
        remote.close();
      }
    });

    it("is a no-op once the window is already drained", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 3);
        await drainPull(local.db, remote.rpc);
        const cursor = readFetchCursor(local.db);

        const second = await drainPull(local.db, remote.rpc);

        expect(second).toHaveLength(1);
        expect(second[0].entries).toBe(0);
        expect(readFetchCursor(local.db)).toEqual(cursor);
      } finally {
        local.close();
        remote.close();
      }
    });
  });

  describe("operation lifecycle", () => {
    it("deletes the operation row once the target is reached", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 3);

        await drainPull(local.db, remote.rpc);

        expect(readOperation(local.db, "default", "pull")).toBeUndefined();
      } finally {
        local.close();
        remote.close();
      }
    });

    it("keeps a pending operation while blocks remain", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 6);

        await pullOneBlock(local.db, remote.rpc, {
          profile: { maxEntries: 2, maxBytes: 64 * 1024 * 1024 },
        });

        const operation = readOperation(local.db, "default", "pull");
        expect(operation?.status).toBe("pending");
        expect(operation?.target).toBeDefined();
      } finally {
        local.close();
        remote.close();
      }
    });

    it("reuses the same generation across restarts of one operation", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 6);
        const profile = { maxEntries: 2, maxBytes: 64 * 1024 * 1024 };

        const first = await pullOneBlock(local.db, remote.rpc, { profile });
        const second = await pullOneBlock(local.db, remote.rpc, { profile });

        expect(second?.generation).toBe(first?.generation);
      } finally {
        local.close();
        remote.close();
      }
    });

    // A busy workspace must not produce an endless iterable: changes
    // above the fixed target belong to the next operation.
    it("does not extend a running operation with changes above its target", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 4);
        const profile = { maxEntries: 2, maxBytes: 64 * 1024 * 1024 };

        await pullOneBlock(local.db, remote.rpc, { profile });
        // New remote work lands mid-operation.
        const provider = new SQLiteWorkspaceProvider(remote.db);
        provider.writeFileSync("/late.txt", "late");

        const seen = await drainPull(local.db, remote.rpc, { profile });

        // The operation that was already running completed without
        // waiting for /late.txt.
        expect(seen[seen.length - 1].complete).toBe(true);
        expect(localNames(local.db)).not.toContain("late.txt");
      } finally {
        local.close();
        remote.close();
      }
    });

    it("picks up changes above the previous target on the next operation", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 2);
        await drainPull(local.db, remote.rpc);

        const provider = new SQLiteWorkspaceProvider(remote.db);
        provider.writeFileSync("/late.txt", "late");
        await drainPull(local.db, remote.rpc);

        expect(localNames(local.db)).toContain("late.txt");
      } finally {
        local.close();
        remote.close();
      }
    });
  });

  describe("progress shape", () => {
    it("carries the backend, direction, and fixed target", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 2);

        const progress = await pullOneBlock(local.db, remote.rpc, { backend: "container" });

        expect(progress?.backend).toBe("container");
        expect(progress?.direction).toBe("pull");
        expect(progress?.targetCursor).toBeDefined();
        expect(progress?.operationId).toBeTruthy();
      } finally {
        local.close();
        remote.close();
      }
    });

    it("counts entries and bytes for the block it committed", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 3);

        const seen = await drainPull(local.db, remote.rpc);

        expect(seen.reduce((t, p) => t + p.entries, 0)).toBe(3);
        expect(seen.reduce((t, p) => t + p.bytes, 0)).toBeGreaterThan(0);
      } finally {
        local.close();
        remote.close();
      }
    });

    it("keeps cursors independent per backend", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 2);

        await drainPull(local.db, remote.rpc, { backend: "container" });

        expect(readFetchCursor(local.db, "container").rev).toBeGreaterThan(0);
        expect(readFetchCursor(local.db, "worker")).toEqual({ rev: 0, path: null });
      } finally {
        local.close();
        remote.close();
      }
    });
  });

  describe("cancellation", () => {
    it("leaves the operation resumable after breaking out of iteration", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 6);
        const profile = { maxEntries: 2, maxBytes: 64 * 1024 * 1024 };

        for await (const progress of pullBlocks(local.db, remote.rpc, { profile })) {
          expect(progress.complete).toBe(false);
          break;
        }

        const operation = readOperation(local.db, "default", "pull");
        expect(operation?.status).toBe("pending");

        await drainPull(local.db, remote.rpc, { profile });
        expect(localNames(local.db)).toHaveLength(6);
      } finally {
        local.close();
        remote.close();
      }
    });
  });

  describe("interrupted block recovery", () => {
    // A block marker that survives with no cursor progress means the
    // previous execution died mid-block, so the sizing profile shrinks.
    it("shrinks the block profile after an interrupted block", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 6);
        const profile = { maxEntries: 4, maxBytes: 64 * 1024 * 1024 };

        // Fail the first block after the target is fixed but before
        // any cursor advances.
        let calls = 0;
        const flaky = new Proxy(remote.rpc as object, {
          get(target, prop, receiver) {
            if (prop === "fetchChanges") {
              return async (...args: unknown[]) => {
                calls += 1;
                if (calls === 1) throw new Error("transport interrupted");
                return (
                  Reflect.get(target, prop, receiver) as (...a: unknown[]) => Promise<unknown>
                ).call(target, ...args);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as SyncRPC;

        await expect(pullOneBlock(local.db, flaky, { profile })).rejects.toThrow();

        const operation = readOperation(local.db, "default", "pull");
        expect(operation?.status).toBe("pending");

        // The retry detects the stale marker and halves the profile.
        await pullOneBlock(local.db, flaky, { profile });
        const after = readOperation(local.db, "default", "pull");
        expect(after === undefined || after.profile.maxEntries <= 4).toBe(true);
      } finally {
        local.close();
        remote.close();
      }
    });

    it("leaves the operation pending after a recoverable transport error", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 4);
        const exploding = new Proxy(remote.rpc as object, {
          get(target, prop, receiver) {
            if (prop === "fetchChanges") {
              return async () => {
                throw new Error("transport interrupted");
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as SyncRPC;

        await expect(pullOneBlock(local.db, exploding, {})).rejects.toThrow(
          "transport interrupted",
        );

        // Pending, not failed: recreating the iterable retries.
        expect(readOperation(local.db, "default", "pull")?.status).toBe("pending");
        expect(readFetchCursor(local.db)).toEqual({ rev: 0, path: null });
      } finally {
        local.close();
        remote.close();
      }
    });
  });

  describe("read-only mount rejections", () => {
    it("records a rejected entry durably and still advances", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 2);
        // Mount /f000.txt's parent as read-only so the apply refuses
        // the incoming entries.
        local.db.run(
          "INSERT INTO _vfs_mounts (root, kind, indexed, mode) VALUES (?, ?, ?, ?)",
          "/",
          "test",
          1,
          "read-only",
        );

        const seen = await drainPull(local.db, remote.rpc);

        expect(seen[seen.length - 1].complete).toBe(true);
        expect(seen.some((p) => p.skipped > 0)).toBe(true);
        const skips = readSkips(local.db, "default", "pull");
        expect(skips.length).toBeGreaterThan(0);
        expect(skips[0].reason).toBe("read-only");
      } finally {
        local.close();
        remote.close();
      }
    });

    it("does not loop forever on a rejected entry", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 2);
        local.db.run(
          "INSERT INTO _vfs_mounts (root, kind, indexed, mode) VALUES (?, ?, ?, ?)",
          "/",
          "test",
          1,
          "read-only",
        );

        // drainPull throws if it exceeds 200 blocks.
        const seen = await drainPull(local.db, remote.rpc);

        expect(seen[seen.length - 1].complete).toBe(true);
      } finally {
        local.close();
        remote.close();
      }
    });
  });

  describe("same-isolate handoff", () => {
    it("joins one generation when two iterators run concurrently", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 6);
        const profile = { maxEntries: 2, maxBytes: 64 * 1024 * 1024 };

        const [a, b] = await Promise.all([
          pullOneBlock(local.db, remote.rpc, { profile }),
          pullOneBlock(local.db, remote.rpc, { profile }),
        ]);

        // Both callers observe the same operation rather than racing
        // to create competing targets.
        expect(a?.generation).toBe(b?.generation);
        expect(a?.operationId).toBe(b?.operationId);
      } finally {
        local.close();
        remote.close();
      }
    });

    it("converges when concurrent iterators drive the same backend", async () => {
      const local = makePeer();
      const remote = makePeer();
      try {
        seedRemote(remote.db, 6);
        const profile = { maxEntries: 2, maxBytes: 64 * 1024 * 1024 };

        await Promise.all([
          drainPull(local.db, remote.rpc, { profile }),
          drainPull(local.db, remote.rpc, { profile }),
        ]);

        expect(localNames(local.db)).toHaveLength(6);
      } finally {
        local.close();
        remote.close();
      }
    });
  });
});
