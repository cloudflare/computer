import { describe, expect, it } from "vitest";

import { withDB } from "../fs/with-db.js";
import {
  beginCapture,
  clearBlockMarker,
  completeOperation,
  DEFAULT_BLOCK_PROFILE,
  failOperation,
  fixTarget,
  MIN_BLOCK_PROFILE,
  markBlockStarted,
  openOperation,
  pruneSkips,
  readOperation,
  readSkips,
  recordSkip,
  shrinkBlockProfile,
} from "./operations.js";

// The operation row is the durable half of a restartable sync. These
// tests treat it as a state machine: absent -> capturing -> pending ->
// absent, with failed and lost as terminal branches. Every transition
// has to survive being re-read by a fresh caller, because after a
// Durable Object eviction that is the only thing left.

describe("sync operations", () => {
  describe("creation and target capture", () => {
    it("reports no operation for a backend that has never synced", async () => {
      await withDB(async (db) => {
        expect(readOperation(db, "container", "pull")).toBeUndefined();
      });
    });

    it("beginCapture inserts a capturing row with no target", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");

        const operation = readOperation(db, "container", "pull");
        expect(operation?.status).toBe("capturing");
        expect(operation?.generation).toBe(generation);
        expect(operation?.target).toBeUndefined();
      });
    });

    it("fixTarget promotes a capturing row to pending with a fixed target", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");

        const promoted = fixTarget(db, "container", "pull", generation, {
          target: { rev: 42, path: null },
          mode: "entries",
        });

        expect(promoted).toBe(true);
        const operation = readOperation(db, "container", "pull");
        expect(operation?.status).toBe("pending");
        expect(operation?.target).toEqual({ rev: 42, path: null });
        expect(operation?.mode).toBe("entries");
      });
    });

    it("preserves a same-revision path through target serialization", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", generation, {
          target: { rev: 7, path: "/dir/file.txt" },
          mode: "pack",
        });

        expect(readOperation(db, "container", "pull")?.target).toEqual({
          rev: 7,
          path: "/dir/file.txt",
        });
      });
    });

    it("treats the empty string as a real target path, not a sentinel", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", generation, {
          target: { rev: 9, path: "" },
          mode: "entries",
        });

        expect(readOperation(db, "container", "pull")?.target).toEqual({ rev: 9, path: "" });
      });
    });

    it("keys operations independently by backend and direction", async () => {
      await withDB(async (db) => {
        const pull = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", pull, {
          target: { rev: 1, path: null },
          mode: "entries",
        });
        const push = beginCapture(db, "container", "push");
        fixTarget(db, "container", "push", push, {
          target: { rev: 2, path: null },
          mode: "entries",
        });
        const other = beginCapture(db, "worker", "pull");
        fixTarget(db, "worker", "pull", other, {
          target: { rev: 3, path: null },
          mode: "entries",
        });

        expect(readOperation(db, "container", "pull")?.target?.rev).toBe(1);
        expect(readOperation(db, "container", "push")?.target?.rev).toBe(2);
        expect(readOperation(db, "worker", "pull")?.target?.rev).toBe(3);
      });
    });

    it("repeats capture when eviction interrupted the first attempt", async () => {
      await withDB(async (db) => {
        // First iterator inserted a capturing row and was evicted
        // before it could fix a target.
        beginCapture(db, "container", "pull");

        // A fresh iterator finds the capturing row and takes it over
        // with a new generation, because the abandoned generation may
        // still be in flight remotely.
        const second = beginCapture(db, "container", "pull");
        const operation = readOperation(db, "container", "pull");

        expect(operation?.generation).toBe(second);
        expect(operation?.status).toBe("capturing");
      });
    });

    it("rejects a target fixed against a superseded generation", async () => {
      await withDB(async (db) => {
        const stale = beginCapture(db, "container", "pull");
        beginCapture(db, "container", "pull");

        const promoted = fixTarget(db, "container", "pull", stale, {
          target: { rev: 99, path: null },
          mode: "entries",
        });

        expect(promoted).toBe(false);
        expect(readOperation(db, "container", "pull")?.status).toBe("capturing");
      });
    });
  });

  describe("joining an existing operation", () => {
    it("openOperation returns the pending operation instead of a new target", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", generation, {
          target: { rev: 42, path: null },
          mode: "entries",
        });

        const joined = openOperation(db, "container", "pull");

        expect(joined.joined).toBe(true);
        expect(joined.operation.generation).toBe(generation);
        expect(joined.operation.target).toEqual({ rev: 42, path: null });
      });
    });

    it("openOperation starts a capture when no operation exists", async () => {
      await withDB(async (db) => {
        const opened = openOperation(db, "container", "pull");

        expect(opened.joined).toBe(false);
        expect(opened.operation.status).toBe("capturing");
      });
    });

    it("openOperation replaces a failed operation with a new generation", async () => {
      await withDB(async (db) => {
        const first = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", first, {
          target: { rev: 5, path: null },
          mode: "entries",
        });
        failOperation(db, "container", "pull", first, "failed", "transport exploded");

        const opened = openOperation(db, "container", "pull");

        expect(opened.joined).toBe(false);
        expect(opened.operation.generation).not.toBe(first);
        expect(opened.operation.status).toBe("capturing");
      });
    });
  });

  describe("completion and failure", () => {
    it("completeOperation deletes the row so the next call captures a new target", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", generation, {
          target: { rev: 5, path: null },
          mode: "entries",
        });

        expect(completeOperation(db, "container", "pull", generation)).toBe(true);
        expect(readOperation(db, "container", "pull")).toBeUndefined();
      });
    });

    it("ignores a completion from a superseded generation", async () => {
      await withDB(async (db) => {
        const stale = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", stale, {
          target: { rev: 5, path: null },
          mode: "entries",
        });
        failOperation(db, "container", "pull", stale, "failed", "boom");
        const replacement = openOperation(db, "container", "pull").operation.generation;

        expect(completeOperation(db, "container", "pull", stale)).toBe(false);
        expect(readOperation(db, "container", "pull")?.generation).toBe(replacement);
      });
    });

    it("retains a lost operation with its error for diagnostics", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", generation, {
          target: { rev: 5, path: null },
          mode: "entries",
        });

        failOperation(db, "container", "pull", generation, "lost", "EEXEC_LOST");

        const operation = readOperation(db, "container", "pull");
        expect(operation?.status).toBe("lost");
        expect(operation?.lastError).toBe("EEXEC_LOST");
      });
    });

    it("ignores a failure reported against a superseded generation", async () => {
      await withDB(async (db) => {
        const stale = beginCapture(db, "container", "pull");
        beginCapture(db, "container", "pull");

        expect(failOperation(db, "container", "pull", stale, "failed", "late")).toBe(false);
        expect(readOperation(db, "container", "pull")?.status).toBe("capturing");
      });
    });
  });

  describe("block markers and sizing profile", () => {
    it("starts an operation at the default block profile", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", generation, {
          target: { rev: 5, path: null },
          mode: "pack",
        });

        expect(readOperation(db, "container", "pull")?.profile).toEqual(DEFAULT_BLOCK_PROFILE);
      });
    });

    it("records the cursor a block started from", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", generation, {
          target: { rev: 5, path: null },
          mode: "pack",
        });

        markBlockStarted(db, "container", "pull", generation, { rev: 2, path: "/a" }, 1000);

        const operation = readOperation(db, "container", "pull");
        expect(operation?.blockAfter).toEqual({ rev: 2, path: "/a" });
        expect(operation?.blockStartedAt).toBe(1000);
      });
    });

    it("clears the block marker after the cursor advances", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", generation, {
          target: { rev: 5, path: null },
          mode: "pack",
        });
        markBlockStarted(db, "container", "pull", generation, { rev: 2, path: null }, 1000);

        clearBlockMarker(db, "container", "pull", generation);

        expect(readOperation(db, "container", "pull")?.blockAfter).toBeUndefined();
      });
    });

    it("halves the profile when a block is detected as interrupted", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", generation, {
          target: { rev: 5, path: null },
          mode: "pack",
        });

        shrinkBlockProfile(db, "container", "pull", generation);

        expect(readOperation(db, "container", "pull")?.profile).toEqual({
          maxEntries: DEFAULT_BLOCK_PROFILE.maxEntries / 2,
          maxBytes: DEFAULT_BLOCK_PROFILE.maxBytes / 2,
        });
      });
    });

    it("stops shrinking at the minimum profile instead of reaching zero", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", generation, {
          target: { rev: 5, path: null },
          mode: "pack",
        });

        for (let i = 0; i < 20; i++) {
          shrinkBlockProfile(db, "container", "pull", generation);
        }

        expect(readOperation(db, "container", "pull")?.profile).toEqual(MIN_BLOCK_PROFILE);
      });
    });

    // The plan proposed halving on interruption but never restored the
    // profile, so one eviction storm would leave a workspace slow
    // forever. Completion resets it. See docs/decisions/sync-operations.md.
    it("restores the default profile for the operation after a shrunk one completes", async () => {
      await withDB(async (db) => {
        const first = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", first, {
          target: { rev: 5, path: null },
          mode: "pack",
        });
        shrinkBlockProfile(db, "container", "pull", first);
        completeOperation(db, "container", "pull", first);

        const second = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", second, {
          target: { rev: 9, path: null },
          mode: "pack",
        });

        expect(readOperation(db, "container", "pull")?.profile).toEqual(DEFAULT_BLOCK_PROFILE);
      });
    });
  });

  describe("runtime identity", () => {
    it("carries the source runtime id so a replaced container can be fenced", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", generation, {
          target: { rev: 5, path: null },
          mode: "entries",
          runtimeId: "runtime-a",
        });

        expect(readOperation(db, "container", "pull")?.runtimeId).toBe("runtime-a");
      });
    });
  });

  describe("skipped entries", () => {
    // A rejection that lives only in a yielded progress value is
    // unauditable once the caller discards it, so rejections are
    // durable. See docs/decisions/sync-operations.md.
    it("records a rejected read-only entry against the operation generation", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", generation, {
          target: { rev: 5, path: null },
          mode: "entries",
        });

        recordSkip(db, "container", "pull", generation, "/ro/file.txt", "EROFS", 2000);

        expect(readSkips(db, "container", "pull")).toEqual([
          {
            generation,
            path: "/ro/file.txt",
            reason: "EROFS",
            at: 2000,
          },
        ]);
      });
    });

    it("keeps skip rows after the operation row is deleted", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", generation, {
          target: { rev: 5, path: null },
          mode: "entries",
        });
        recordSkip(db, "container", "pull", generation, "/ro/file.txt", "EROFS", 2000);

        completeOperation(db, "container", "pull", generation);

        expect(readSkips(db, "container", "pull")).toHaveLength(1);
      });
    });

    it("prunes skips from earlier generations when a new operation starts", async () => {
      await withDB(async (db) => {
        const first = beginCapture(db, "container", "pull");
        fixTarget(db, "container", "pull", first, {
          target: { rev: 5, path: null },
          mode: "entries",
        });
        recordSkip(db, "container", "pull", first, "/ro/old.txt", "EROFS", 1000);
        completeOperation(db, "container", "pull", first);

        const second = beginCapture(db, "container", "pull");
        pruneSkips(db, "container", "pull", second);

        expect(readSkips(db, "container", "pull")).toEqual([]);
      });
    });

    it("does not leak skips across backends", async () => {
      await withDB(async (db) => {
        const generation = beginCapture(db, "container", "pull");
        recordSkip(db, "container", "pull", generation, "/ro/file.txt", "EROFS", 2000);

        expect(readSkips(db, "worker", "pull")).toEqual([]);
      });
    });
  });
});
