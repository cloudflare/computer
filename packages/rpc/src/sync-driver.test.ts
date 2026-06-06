import {
  type ChangeEntry,
  currentRev,
  Database,
  initializeSchema,
  readFetchCursor,
  readWatermark,
  SQLiteWorkspaceProvider,
  stageBlob,
  writeFetchCursor,
  writeWatermark,
} from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import type { SyncRPC } from "./interface.js";
import { createSyncServer } from "./server.js";
import { pullOnce, pushOnce, reconcileWatermarks, tick } from "./sync-driver.js";

// Two peers wired up as direct in-process SyncRPC stubs. No
// WebSocket; we already have the real-wire convergence test in
// wire.test.ts. These tests exercise the driver loop, not the
// transport.
function makePeer(): { db: Database; rpc: SyncRPC; close: () => void } {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => 1000);
  const rpc = createSyncServer(db);
  return { db, rpc, close: () => storage.close() };
}

function fileEntries(db: Database): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM vfs_dirents WHERE parent_inode = 1 ORDER BY name")
    .map((r) => r.name);
}

async function drainStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

// Wrap a SyncRPC so the fetchChanges result carries a tracked
// [Symbol.dispose]. pullOnce owns that envelope and must dispose it on
// every exit, including the throwing paths. Options inject the two
// failure modes: a lying appliedPushCursor (trips the cross-side
// invariant before the stream is read) and an empty hasObjects (forces
// applyChanges to throw on a missing object mid-stream).
function trackFetchDisposal(
  rpc: SyncRPC,
  opts: { lowerCursor?: boolean; failHasObjects?: boolean } = {},
): { rpc: SyncRPC; disposeCount: () => number } {
  let disposeCount = 0;
  const wrapped = new Proxy(rpc as object, {
    get(target, prop, receiver) {
      if (prop === "fetchChanges") {
        return async (...args: Parameters<SyncRPC["fetchChanges"]>) => {
          const real = await Reflect.get(target, prop, receiver).call(target, ...args);
          return {
            ...real,
            ...(opts.lowerCursor ? { appliedPushCursor: { rev: 0, path: null } } : {}),
            [Symbol.dispose]() {
              disposeCount += 1;
            },
          };
        };
      }
      if (prop === "hasObjects" && opts.failHasObjects) {
        return async () => [];
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as SyncRPC;
  return { rpc: wrapped, disposeCount: () => disposeCount };
}

describe("sync driver — pullOnce", () => {
  it("pulls a single entry from upstream", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const provider = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      provider.writeFileSync("/hello.txt", "hello");

      const applied = await pullOnce(b.db, a.rpc);
      expect(applied.applied).toBe(1);
      expect(applied.skipped).toEqual([]);
      expect(fileEntries(b.db)).toContain("hello.txt");
      // Asserting the bytes arrived, not just the dirent. The
      // production container example had a path where pullOnce
      // returned 1 (entry materialised) but the file's chunks were
      // empty on the receiver — RPC reads landed HTTP 200 / 0 bytes.
      const providerB = new SQLiteWorkspaceProvider(b.db, { now: () => 1 });
      expect(providerB.readFileSync("/hello.txt", "utf8")).toBe("hello");
    } finally {
      a.close();
      b.close();
    }
  });

  it("pulls bytes written through the fd table (FUSE-shaped write)", async () => {
    // Mirrors the FUSE path: openSync + writeSync + closeSync rather
    // than the whole-file writeFileSync above. Both go through
    // writeFileSyncImpl internally and should bump vfs_nodes.rev
    // identically; this test pins that pull semantics survive the
    // positional-write flow that FUSE uses.
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      const fd = providerA.openSync("/fuse.txt", "w");
      const payload = Buffer.from("from-fuse\n", "utf8");
      providerA.writeSync(fd, payload, 0, payload.byteLength, null);
      providerA.closeSync(fd);

      const applied = await pullOnce(b.db, a.rpc);
      expect(applied.applied).toBe(1);
      expect(applied.skipped).toEqual([]);
      expect(fileEntries(b.db)).toContain("fuse.txt");

      // The production bug: the dirent transferred but readback was
      // empty. Assert byte equality, not just dirent presence.
      const providerB = new SQLiteWorkspaceProvider(b.db, { now: () => 1 });
      expect(providerB.readFileSync("/fuse.txt", "utf8")).toBe("from-fuse\n");
    } finally {
      a.close();
      b.close();
    }
  });

  it("is a no-op when fetchRev equals upstream currentRev", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      await pullOnce(b.db, a.rpc);
      const applied = await pullOnce(b.db, a.rpc);
      expect(applied.applied).toBe(0);
      expect(applied.skipped).toEqual([]);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("sync driver — pushOnce", () => {
  it("pushes local entries to the remote", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      providerA.writeFileSync("/hi.txt", "hi");

      const pushed = await pushOnce(a.db, b.rpc);
      expect(pushed).toBe(1);
      expect(fileEntries(b.db)).toContain("hi.txt");
    } finally {
      a.close();
      b.close();
    }
  });

  it("advances pushRev on success", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      providerA.writeFileSync("/hi.txt", "hi");
      await pushOnce(a.db, b.rpc);
      expect(readWatermark(a.db, "pushRev")).toBe(currentRev(a.db));
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("SyncRPC server — afterApply hook", () => {
  // Peer factory that returns a thenable `afterApply` spy alongside the
  // standard fixture. Used by the three tests below to assert the hook
  // fires exactly once per push and that errors don't surface as push
  // failures.
  function makeReceiverWithSpy(): {
    db: Database;
    rpc: SyncRPC;
    close: () => void;
    calls: number;
    setAfterApply: (fn: () => void | Promise<void>) => void;
  } {
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);
    initializeSchema(db, () => 1000);
    let hook: () => void | Promise<void> = () => {};
    let calls = 0;
    const rpc = createSyncServer(db, {
      afterApply: async () => {
        calls += 1;
        await hook();
      },
    });
    return {
      db,
      rpc,
      close: () => storage.close(),
      get calls() {
        return calls;
      },
      setAfterApply: (fn) => {
        hook = fn;
      },
    };
  }

  it("fires once per push, after entries are committed", async () => {
    const a = makePeer();
    const b = makeReceiverWithSpy();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      providerA.writeFileSync("/hi.txt", "hi");

      let entriesAtHook = -1;
      b.setAfterApply(() => {
        // Snapshot the receiver's vfs_dirents at the moment the hook
        // fires. The transaction already committed, so the file must
        // be visible here.
        entriesAtHook = fileEntries(b.db).length;
      });

      const pushed = await pushOnce(a.db, b.rpc);
      expect(pushed).toBe(1);
      expect(b.calls).toBe(1);
      expect(entriesAtHook).toBeGreaterThan(0);
      expect(fileEntries(b.db)).toContain("hi.txt");
    } finally {
      a.close();
      b.close();
    }
  });

  it("is not called for empty pushes", async () => {
    const a = makePeer();
    const b = makeReceiverWithSpy();
    try {
      // No writes on a, so pushOnce ships zero entries.
      const pushed = await pushOnce(a.db, b.rpc);
      expect(pushed).toBe(0);
      expect(b.calls).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });

  it("a thrown hook does not fail the push", async () => {
    const a = makePeer();
    const b = makeReceiverWithSpy();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      providerA.writeFileSync("/hi.txt", "hi");

      b.setAfterApply(() => {
        throw new Error("settle blew up");
      });

      // The push must still succeed — entries are committed before
      // the hook runs, and the server logs+swallows hook errors.
      const pushed = await pushOnce(a.db, b.rpc);
      expect(pushed).toBe(1);
      expect(b.calls).toBe(1);
      expect(fileEntries(b.db)).toContain("hi.txt");
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("SyncRPC server — beforeFetch hook", () => {
  // Symmetric to the afterApply spy above. beforeFetch runs on the
  // receiver right before fetchChanges streams entries, giving the
  // host a chance to settle any out-of-band writes (e.g. wsd's shim
  // pulling disk changes into the VFS) into the store the fetch is
  // about to read.
  function makeReceiverWithSpy(): {
    db: Database;
    rpc: SyncRPC;
    close: () => void;
    calls: number;
    setBeforeFetch: (fn: () => void | Promise<void>) => void;
  } {
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);
    initializeSchema(db, () => 1000);
    let hook: () => void | Promise<void> = () => {};
    let calls = 0;
    const rpc = createSyncServer(db, {
      beforeFetch: async () => {
        calls += 1;
        await hook();
      },
    });
    return {
      db,
      rpc,
      close: () => storage.close(),
      get calls() {
        return calls;
      },
      setBeforeFetch: (fn) => {
        hook = fn;
      },
    };
  }

  it("fires once per fetchChanges and is awaited before entries stream", async () => {
    const a = makePeer();
    const b = makeReceiverWithSpy();
    try {
      // Stage a write in the hook itself — simulates the shim's
      // disk→VFS reconcile picking up a file that wasn't in the VFS
      // when pullOnce started.
      const providerB = new SQLiteWorkspaceProvider(b.db, { now: () => 2 });
      b.setBeforeFetch(() => {
        providerB.writeFileSync("/late.txt", "materialised by hook");
      });

      const result = await pullOnce(a.db, b.rpc);
      expect(b.calls).toBe(1);
      // The pull must surface the entry the hook wrote — that's the
      // whole point of beforeFetch existing.
      expect(result.applied).toBeGreaterThan(0);
      expect(fileEntries(a.db)).toContain("late.txt");
    } finally {
      a.close();
      b.close();
    }
  });

  it("fires even when there are no changes to stream", async () => {
    // Pulling against an empty receiver still has to call the hook,
    // because the hook is what produces "any changes" in the first
    // place — conditional firing would defeat the contract.
    const a = makePeer();
    const b = makeReceiverWithSpy();
    try {
      const result = await pullOnce(a.db, b.rpc);
      expect(b.calls).toBe(1);
      expect(result.applied).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });

  it("a thrown hook does not fail the fetch", async () => {
    const a = makePeer();
    const b = makeReceiverWithSpy();
    try {
      const providerB = new SQLiteWorkspaceProvider(b.db, { now: () => 2 });
      providerB.writeFileSync("/already-there.txt", "x");

      b.setBeforeFetch(() => {
        throw new Error("reconcile blew up");
      });

      // The fetch must still succeed and return the pre-existing
      // entry. The receiver logs and swallows hook errors.
      const result = await pullOnce(a.db, b.rpc);
      expect(b.calls).toBe(1);
      expect(result.applied).toBe(1);
      expect(fileEntries(a.db)).toContain("already-there.txt");
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("SyncRPC server — fetchChanges snapshots", () => {
  it("bounds the returned stream to the advertised currentCursor", async () => {
    const upstream = makePeer();
    try {
      const provider = new SQLiteWorkspaceProvider(upstream.db, { now: () => 1 });
      provider.writeFileSync("/before.txt", "before");

      const originalAll = upstream.db.all.bind(upstream.db);
      let rewrote = false;
      upstream.db.all = ((query: string, ...bindings: unknown[]) => {
        if (!rewrote && query.startsWith("SELECT inode, rev FROM vfs_nodes WHERE rev > ?")) {
          rewrote = true;
          provider.writeFileSync("/after.txt", "after");
        }
        return originalAll(query, ...bindings);
      }) as typeof upstream.db.all;

      const result = await upstream.rpc.fetchChanges({ after: { rev: 0, path: null } });
      const advertisedCursor = result.currentCursor;

      const entries = await drainStream(result.stream);
      expect(rewrote).toBe(true);
      expect(result.currentCursor).toEqual(advertisedCursor);
      expect(entries.map((entry) => entry.path)).toContain("/before.txt");
      expect(entries.map((entry) => entry.path)).not.toContain("/after.txt");
      expect(advertisedCursor.rev).toBeLessThan(currentRev(upstream.db));
    } finally {
      upstream.close();
    }
  });

  it("pullOnce persists only the advertised snapshot cursor", async () => {
    const upstream = makePeer();
    const downstream = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(upstream.db, { now: () => 1 });
      providerA.writeFileSync("/before.txt", "before");

      let advertisedCursor: { rev: number; path: string | null } | undefined;
      const wrapped = new Proxy(upstream.rpc as object, {
        get(target, prop, receiver) {
          if (prop === "fetchChanges") {
            return async (...args: Parameters<SyncRPC["fetchChanges"]>) => {
              const result = await Reflect.get(target, prop, receiver).call(target, ...args);
              advertisedCursor = result.currentCursor;
              providerA.writeFileSync("/after.txt", "after");
              return result;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof upstream.rpc;

      await pullOnce(downstream.db, wrapped);

      expect(advertisedCursor).toBeDefined();
      expect(fileEntries(downstream.db)).toContain("before.txt");
      expect(fileEntries(downstream.db)).not.toContain("after.txt");
      expect(readFetchCursor(downstream.db)).toEqual(advertisedCursor);
      expect(readFetchCursor(downstream.db).rev).toBeLessThan(currentRev(upstream.db));
    } finally {
      upstream.close();
      downstream.close();
    }
  });
});

describe("sync driver — pullOnce envelope disposal", () => {
  it("disposes the fetchChanges envelope when the cross-side invariant trips", async () => {
    const remote = makePeer();
    try {
      const local = new Database(new SQLiteTestStorage());
      initializeSchema(local, () => 1000);
      // Local claims to have pushed rev 42; the wrapper echoes back a
      // rev-0 cursor, so assertAppliedPushCursor throws before the
      // stream is ever read.
      writeWatermark(local, "pushRev", 42);
      const providerR = new SQLiteWorkspaceProvider(remote.db, { now: () => 1 });
      providerR.writeFileSync("/seed.txt", "x");

      const tracked = trackFetchDisposal(remote.rpc, { lowerCursor: true });
      await expect(pullOnce(local, tracked.rpc)).rejects.toThrow(/cross-side invariant violated/i);
      expect(tracked.disposeCount()).toBe(1);
    } finally {
      remote.close();
    }
  });

  it("disposes the fetchChanges envelope when applyChanges throws mid-stream", async () => {
    const remote = makePeer();
    const local = makePeer();
    try {
      const providerR = new SQLiteWorkspaceProvider(remote.db, { now: () => 1 });
      providerR.writeFileSync("/seed.txt", "needs-bytes");

      // hasObjects lies (returns nothing), so pullOnce stages no blob
      // bytes and applyChanges throws on the missing object.
      const tracked = trackFetchDisposal(remote.rpc, { failHasObjects: true });
      await expect(pullOnce(local.db, tracked.rpc)).rejects.toThrow(/missing object/i);
      expect(tracked.disposeCount()).toBe(1);
    } finally {
      remote.close();
      local.close();
    }
  });

  it("disposes the fetchChanges envelope on the happy path", async () => {
    const remote = makePeer();
    const local = makePeer();
    try {
      const providerR = new SQLiteWorkspaceProvider(remote.db, { now: () => 1 });
      providerR.writeFileSync("/seed.txt", "x");

      const tracked = trackFetchDisposal(remote.rpc);
      await pullOnce(local.db, tracked.rpc);
      expect(tracked.disposeCount()).toBe(1);
      expect(fileEntries(local.db)).toContain("seed.txt");
    } finally {
      remote.close();
      local.close();
    }
  });
});

describe("sync driver — bidirectional convergence", () => {
  it("two peers writing in parallel converge after a few ticks", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      const providerB = new SQLiteWorkspaceProvider(b.db, { now: () => 2 });

      providerA.writeFileSync("/from-a.txt", "alpha");
      providerB.writeFileSync("/from-b.txt", "beta");

      // Alternate ticks until both sides see both files. Each tick
      // is pull-then-push against the *other* peer's rpc.
      for (let i = 0; i < 4; i++) {
        await tick(a.db, b.rpc);
        await tick(b.db, a.rpc);
      }

      expect(fileEntries(a.db).sort()).toEqual(["from-a.txt", "from-b.txt"]);
      expect(fileEntries(b.db).sort()).toEqual(["from-a.txt", "from-b.txt"]);
    } finally {
      a.close();
      b.close();
    }
  });

  it("an upstream entry does not get re-pushed (loopback suppression)", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      providerA.writeFileSync("/from-a.txt", "alpha");

      // First tick: B pulls from A.
      await tick(b.db, a.rpc);
      expect(fileEntries(b.db)).toContain("from-a.txt");

      // Second tick: B has nothing new to push back. If the
      // loopback suppression is broken, applyChanges bumped
      // vfs_meta.rev on the apply, and the push side would re-ship
      // the same entry.
      const result = await tick(b.db, a.rpc);
      expect(result.pushed).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });

  it("a settled pair stays settled across additional ticks", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      providerA.writeFileSync("/x.txt", "x");
      for (let i = 0; i < 3; i++) {
        await tick(a.db, b.rpc);
        await tick(b.db, a.rpc);
      }
      const result1 = await tick(a.db, b.rpc);
      const result2 = await tick(b.db, a.rpc);
      expect(result1).toEqual({ pulled: { applied: 0, skipped: [] }, pushed: 0 });
      expect(result2).toEqual({ pulled: { applied: 0, skipped: [] }, pushed: 0 });
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("sync driver — cross-side invariant", () => {
  it("pushOnce throws when the remote echoes back a lower appliedPushCursor", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      providerA.writeFileSync("/x.txt", "x");

      // Wrap B's rpc to lie about appliedPushCursor. Simulates a
      // regression in the suppress-dirty-tracking apply path.
      const lyingRpc = new Proxy(b.rpc as object, {
        get(target, prop, receiver) {
          if (prop === "push") {
            return async (input: { senderRev: number; changes: ReadableStream<unknown> }) => {
              const real = await Reflect.get(target, prop, receiver).call(target, input);
              return { ...real, appliedPushCursor: { rev: 0, path: null } };
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof b.rpc;

      await expect(pushOnce(a.db, lyingRpc)).rejects.toThrow(/cross-side invariant violated/i);
    } finally {
      a.close();
      b.close();
    }
  });

  it("pullOnce throws when fetchChanges echoes back a lower appliedPushCursor", async () => {
    // Symmetric to the push case. fetchChanges returns the remote's
    // appliedPushCursor alongside the entry stream; the DO asserts
    // appliedPushCursor covers pushRev before draining, so a regression in
    // the remote's apply path that loses applied state trips the
    // invariant on the next pull instead of corrupting fetchRev.
    const remote = makePeer();
    try {
      // Seed the local pushRev so it's higher than what the lying
      // remote will echo. The remote is otherwise fresh — nothing
      // to fetch.
      const local = new Database(new SQLiteTestStorage());
      initializeSchema(local, () => 1000);
      writeWatermark(local, "pushRev", 42);
      // Make the remote return *something* so the puller drains it.
      const providerR = new SQLiteWorkspaceProvider(remote.db, { now: () => 1 });
      providerR.writeFileSync("/seed.txt", "x");

      const lyingRpc = new Proxy(remote.rpc as object, {
        get(target, prop, receiver) {
          if (prop === "fetchChanges") {
            return (input: Parameters<SyncRPC["fetchChanges"]>[0]) => {
              const real = Reflect.get(target, prop, receiver).call(target, input);
              return { ...real, appliedPushCursor: { rev: 0, path: null } };
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof remote.rpc;

      await expect(pullOnce(local, lyingRpc)).rejects.toThrow(/cross-side invariant violated/i);
    } finally {
      remote.close();
    }
  });

  it("fetchChanges reports applied push progress as a cursor", async () => {
    const remote = makePeer();
    try {
      writeFetchCursor(remote.db, { rev: 42, path: "/partial.txt" });

      const result = await remote.rpc.fetchChanges({ after: { rev: 0, path: null } });

      expect(result.appliedPushCursor).toEqual({ rev: 42, path: "/partial.txt" });
      await result.stream.cancel();
    } finally {
      remote.close();
    }
  });

  it("pullOnce rejects when the remote only partially applied local pushRev", async () => {
    const remote = makePeer();
    try {
      const local = new Database(new SQLiteTestStorage());
      initializeSchema(local, () => 1000);
      writeWatermark(local, "pushRev", 42);
      writeFetchCursor(remote.db, { rev: 42, path: "/partial.txt" });

      await expect(pullOnce(local, remote.rpc)).rejects.toThrow(/cross-side invariant violated/i);
    } finally {
      remote.close();
    }
  });

  it("pullOnce accepts a partial remote cursor after local pushRev", async () => {
    const remote = makePeer();
    try {
      const local = new Database(new SQLiteTestStorage());
      initializeSchema(local, () => 1000);
      writeWatermark(local, "pushRev", 42);
      writeFetchCursor(remote.db, { rev: 43, path: "/partial.txt" });

      const result = await pullOnce(local, remote.rpc);

      expect(result).toEqual({ applied: 0, skipped: [] });
    } finally {
      remote.close();
    }
  });
});

describe("sync driver — streaming pullOnce", () => {
  it("applies the entry stream in batches rather than buffering it whole", async () => {
    // Source writes more entries than the batch size. The receiver
    // should call hasObjects() more than once — once per batch —
    // proving it didn't buffer the entire entry stream first.
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      // PULL_BATCH_SIZE in sync-driver.ts is 256. Write twice that to
      // force at least two batches.
      const total = 600;
      for (let i = 0; i < total; i++) {
        providerA.writeFileSync(`/f${i}.txt`, `c${i}`);
      }
      let hasObjectsCalls = 0;
      const wrapped = new Proxy(a.rpc as object, {
        get(target, prop, receiver) {
          if (prop === "hasObjects") {
            return async (hashes: Uint8Array[]) => {
              hasObjectsCalls++;
              return Reflect.get(target, prop, receiver).call(target, hashes);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof a.rpc;
      const applied = await pullOnce(b.db, wrapped);
      expect(applied.applied).toBe(total);
      expect(applied.skipped).toEqual([]);
      expect(fileEntries(b.db).length).toBe(total);
      // With a 256-entry batch we expect at least 3 calls.
      expect(hasObjectsCalls).toBeGreaterThanOrEqual(3);
    } finally {
      a.close();
      b.close();
    }
  });

  it("advances fetchRev per committed batch, not once at end-of-stream", async () => {
    // The roadmap item: on a crash mid-pull, wasted work should be
    // bounded by the in-flight batch (PULL_BATCH_SIZE = 256), not by
    // the whole stream. After each batch's applyChanges commits,
    // fetchRev should reflect the max rev of that batch — not stay
    // at the previous watermark until the final stream end.
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      // Write > PULL_BATCH_SIZE entries so the puller sees at least
      // two batches.
      const total = 400;
      for (let i = 0; i < total; i++) {
        providerA.writeFileSync(`/f${i.toString().padStart(4, "0")}.txt`, `c${i}`);
      }
      const remoteFinalRev = currentRev(a.db);

      // Sample fetchRev after each batch's applyChanges by
      // intercepting hasObjects — by the time hasObjects fires for
      // batch N, batch N-1 has already committed and advanced
      // fetchRev.
      const sampledRevs: number[] = [];
      const wrapped = new Proxy(a.rpc as object, {
        get(target, prop, receiver) {
          if (prop === "hasObjects") {
            return async (hashes: Uint8Array[]) => {
              sampledRevs.push(readWatermark(b.db, "fetchRev"));
              return Reflect.get(target, prop, receiver).call(target, hashes);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof a.rpc;

      await pullOnce(b.db, wrapped);

      // First batch's hasObjects call sees fetchRev = 0 (nothing
      // committed yet). Subsequent batches see strictly increasing
      // values — that's the property the per-batch advance buys.
      expect(sampledRevs.length).toBeGreaterThanOrEqual(2);
      expect(sampledRevs[0]).toBe(0);
      for (let i = 1; i < sampledRevs.length; i++) {
        expect(sampledRevs[i]).toBeGreaterThan(sampledRevs[i - 1]);
      }
      // End state still matches the remote.
      expect(readWatermark(b.db, "fetchRev")).toBe(remoteFinalRev);
    } finally {
      a.close();
      b.close();
    }
  });

  it("does not let an older overlapping pull move the fetch cursor backward", async () => {
    const upstream = makePeer();
    const downstream = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(upstream.db, { now: () => 1 });
      const providerB = new SQLiteWorkspaceProvider(downstream.db, { now: () => 1 });
      for (let i = 0; i < 300; i++) {
        providerA.writeFileSync(`/f${i.toString().padStart(3, "0")}.txt`, `old ${i}`);
      }

      let releaseOldHasObjects: (() => void) | undefined;
      let oldHasObjectsEntered: (() => void) | undefined;
      const oldHasObjectsStarted = new Promise<void>((resolve) => {
        oldHasObjectsEntered = resolve;
      });
      const oldHasObjectsGate = new Promise<void>((resolve) => {
        releaseOldHasObjects = resolve;
      });
      const sampledCursorBeforeSecondOldBatch: Array<{ rev: number; path: string | null }> = [];
      let oldHasObjectsCalls = 0;
      const olderRpc = new Proxy(upstream.rpc as object, {
        get(target, prop, receiver) {
          if (prop === "hasObjects") {
            return async (hashes: Uint8Array[]) => {
              oldHasObjectsCalls++;
              if (oldHasObjectsCalls === 1) {
                oldHasObjectsEntered?.();
                await oldHasObjectsGate;
              } else {
                sampledCursorBeforeSecondOldBatch.push(readFetchCursor(downstream.db));
              }
              return Reflect.get(target, prop, receiver).call(target, hashes);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof upstream.rpc;

      const olderPull = pullOnce(downstream.db, olderRpc);
      await oldHasObjectsStarted;

      providerA.writeFileSync("/newer.txt", "newer");
      const newestCursor = { rev: currentRev(upstream.db), path: null };
      const newerPull = await pullOnce(downstream.db, upstream.rpc);
      expect(newerPull.applied).toBe(301);
      expect(readFetchCursor(downstream.db)).toEqual(newestCursor);

      releaseOldHasObjects?.();
      const olderPullResult = await olderPull;

      expect(olderPullResult.applied).toBe(0);
      expect(providerB.readFileSync("/newer.txt", "utf8")).toBe("newer");
      expect(sampledCursorBeforeSecondOldBatch).toEqual([newestCursor]);
      expect(readFetchCursor(downstream.db)).toEqual(newestCursor);
    } finally {
      upstream.close();
      downstream.close();
    }
  });

  it("resumes inside one large same-rev rename after a failed batch", async () => {
    const a = makePeer();
    const b = makePeer();
    try {
      const providerA = new SQLiteWorkspaceProvider(a.db, { now: () => 1 });
      const providerB = new SQLiteWorkspaceProvider(b.db, { now: () => 1 });
      providerA.mkdirSync("/src", {});
      for (let i = 0; i < 300; i++) {
        providerA.writeFileSync(`/src/f${i.toString().padStart(3, "0")}.txt`, `content ${i}`);
      }

      await pullOnce(b.db, a.rpc);
      expect(providerB.readFileSync("/src/f299.txt", "utf8")).toBe("content 299");

      providerA.renameSync("/src", "/dst");
      const renameRev = currentRev(a.db);
      let hasObjectsCalls = 0;
      const flaky = new Proxy(a.rpc as object, {
        get(target, prop, receiver) {
          if (prop === "hasObjects") {
            return async (hashes: Uint8Array[]) => {
              hasObjectsCalls++;
              if (hasObjectsCalls === 2) {
                throw new Error("injected pull failure after first batch");
              }
              return Reflect.get(target, prop, receiver).call(target, hashes);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof a.rpc;

      await expect(pullOnce(b.db, flaky)).rejects.toThrow(/injected pull failure/);
      expect(readFetchCursor(b.db)).toMatchObject({ rev: renameRev });
      expect(readFetchCursor(b.db).path).not.toBeNull();

      const retried = await pullOnce(b.db, a.rpc);
      expect(retried.applied).toBeGreaterThan(0);
      expect(providerB.existsSync("/src")).toBe(false);
      expect(providerB.readFileSync("/dst/f000.txt", "utf8")).toBe("content 0");
      expect(providerB.readFileSync("/dst/f299.txt", "utf8")).toBe("content 299");
      expect(readFetchCursor(b.db)).toEqual({ rev: renameRev, path: null });
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("sync driver — push atomicity", () => {
  it("rolls back the entire batch when applyChanges fails mid-stream", async () => {
    // Construct a push with two file entries: one whose chunk bytes
    // are staged, and one whose chunk hash is bogus so applyChanges
    // throws while assembling the second file. Without atomicity the
    // first file would land in vfs_nodes; with the push wrapped in a
    // transactionSync, both should roll back.
    const b = makePeer();
    try {
      const goodBytes = new TextEncoder().encode("good");
      const goodHash = await sha256(goodBytes);
      stageBlob(b.db, goodHash, goodBytes, 1);
      const bogusHash = new Uint8Array(32);
      bogusHash.fill(0xee);
      const entries: ChangeEntry[] = [
        {
          kind: "file",
          rev: 1,
          path: "/first.txt",
          mode: 0o644,
          mtime: 1,
          size: goodBytes.byteLength,
          chunks: [{ hash: goodHash, size: goodBytes.byteLength }],
        },
        {
          kind: "file",
          rev: 2,
          path: "/second.txt",
          mode: 0o644,
          mtime: 1,
          size: 4,
          chunks: [{ hash: bogusHash, size: 4 }],
        },
      ];
      const changes = new ReadableStream<ChangeEntry>({
        start(controller) {
          for (const e of entries) controller.enqueue(e);
          controller.close();
        },
      });
      const beforeRev = currentRev(b.db);
      // External orchestrator: senderRev = 0.
      await expect(b.rpc.push({ senderRev: 0, changes })).rejects.toThrow(/missing object/i);
      // Neither file should be present — the failure rolled back
      // everything, not just the bad entry.
      expect(fileEntries(b.db)).not.toContain("first.txt");
      expect(fileEntries(b.db)).not.toContain("second.txt");
      // currentRev must not have advanced. Without atomicity it
      // would have, because /first.txt's writeFile bumped vfs_meta.rev
      // before /second.txt's failure.
      expect(currentRev(b.db)).toBe(beforeRev);
    } finally {
      b.close();
    }
  });
});

describe("sync driver — reconcileWatermarks", () => {
  // Run on (re)connect. The DO's watermarks survive across DO and
  // container lifetimes; the container's watermarks are
  // process-lifetime in today's wsd. After a container restart with
  // no new DO-side writes, pushOnce's localRev <= sincePush
  // early-return means the assertAppliedPushCursor check never runs and
  // the container's empty FUSE mount is invisible to the DO. The
  // reconcile catches the mismatch by comparing the local cursors
  // against the remote's watermarks(), resetting fetchRev to 0 when
  // the remote's log is shorter than we remember and pushRev to 0
  // when the remote hasn't applied what we claimed to push.
  it("resets fetchRev when the remote's currentRev is behind ours", async () => {
    const remote = makePeer();
    try {
      // Local thinks it has fetched up to rev 42; remote is fresh
      // (currentRev = 1 from initializeSchema seeding the root).
      const local = new Database(new SQLiteTestStorage());
      initializeSchema(local, () => 1000);
      writeWatermark(local, "fetchRev", 42);
      writeWatermark(local, "pushRev", 0);

      await reconcileWatermarks(local, remote.rpc);
      expect(readWatermark(local, "fetchRev")).toBe(0);
      expect(readWatermark(local, "pushRev")).toBe(0);
    } finally {
      remote.close();
    }
  });

  it("resets pushRev when the remote hasn't applied what we shipped", async () => {
    const remote = makePeer();
    try {
      // Local pushRev = 17, but the remote is fresh: its pushRev,
      // which is echoed as appliedPushCursor on the wire, is 0/null.
      const local = new Database(new SQLiteTestStorage());
      initializeSchema(local, () => 1000);
      writeWatermark(local, "fetchRev", 0);
      writeWatermark(local, "pushRev", 17);

      await reconcileWatermarks(local, remote.rpc);
      expect(readWatermark(local, "pushRev")).toBe(0);
    } finally {
      remote.close();
    }
  });

  it("leaves watermarks alone when remote is at least caught up", async () => {
    const remote = makePeer();
    try {
      // Seed the remote with a write so its currentRev > 1.
      const providerR = new SQLiteWorkspaceProvider(remote.db, { now: () => 1 });
      providerR.writeFileSync("/seed.txt", "x");
      // Pretend we fetched it and pushed nothing.
      const local = new Database(new SQLiteTestStorage());
      initializeSchema(local, () => 1000);
      const remoteCurrent = currentRev(remote.db);
      writeWatermark(local, "fetchRev", remoteCurrent);
      writeWatermark(local, "pushRev", 0);

      await reconcileWatermarks(local, remote.rpc);
      expect(readWatermark(local, "fetchRev")).toBe(remoteCurrent);
      expect(readWatermark(local, "pushRev")).toBe(0);
    } finally {
      remote.close();
    }
  });
});

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  hash.update(bytes);
  return new Uint8Array(hash.digest());
}
