import { describe, expect, it } from "vitest";
import { rm } from "../fs/rm.js";
import { withDB } from "../fs/with-db.js";
import { writeFile } from "../fs/writeFile.js";
import type { Database } from "../storage.js";
import { PACK_THRESHOLD_BYTES, PACK_THRESHOLD_ENTRIES, planBlock, selectMode } from "./blocks.js";
import { MIN_BLOCK_PROFILE } from "./operations.js";
import { currentRev } from "./watermarks.js";

// The planner turns a cursor window into one block: an ordered prefix
// of the coalesced change stream, bounded by the internal sizing
// profile. Determinism is the property that matters most — the same
// start cursor and target must produce the same block, because an
// unacknowledged block gets re-requested and the receiver has to be
// able to absorb the replay.

// Distinct content per file. Identical bytes would collapse to one
// content-addressed object and the byte-bound cases would then be
// measuring deduplication rather than the bound.
async function seedFiles(db: Database, count: number, bytes = 4): Promise<void> {
  for (let i = 0; i < count; i++) {
    const name = `/f${String(i).padStart(4, "0")}.txt`;
    const filler = String.fromCharCode(97 + (i % 26)).repeat(Math.max(1, bytes - 1));
    await writeFile(db, name, `${i}${filler}`.slice(0, Math.max(1, bytes)), {}, () => i + 1);
  }
}

describe("block planner", () => {
  describe("ordered prefix selection", () => {
    it("returns an empty drained block for an empty window", async () => {
      await withDB(async (db) => {
        const block = await planBlock(db, {
          after: { rev: 0, path: null },
          through: { rev: currentRev(db), path: null },
          profile: MIN_BLOCK_PROFILE,
        });

        expect(block.entries).toEqual([]);
        expect(block.drained).toBe(true);
      });
    });

    it("selects every entry when the window fits inside the profile", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 3);

        const block = await planBlock(db, {
          after: { rev: 0, path: null },
          through: { rev: currentRev(db), path: null },
          profile: MIN_BLOCK_PROFILE,
        });

        expect(block.entries.map((e) => e.path)).toEqual([
          "/f0000.txt",
          "/f0001.txt",
          "/f0002.txt",
        ]);
        expect(block.drained).toBe(true);
      });
    });

    it("sets the block cursor to the target when the window drains", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 2);
        const target = { rev: currentRev(db), path: null };

        const block = await planBlock(db, {
          after: { rev: 0, path: null },
          through: target,
          profile: MIN_BLOCK_PROFILE,
        });

        expect(block.cursor).toEqual(target);
      });
    });

    it("stops at the entry limit and reports the window as not drained", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 5);

        const block = await planBlock(db, {
          after: { rev: 0, path: null },
          through: { rev: currentRev(db), path: null },
          profile: { maxEntries: 2, maxBytes: MIN_BLOCK_PROFILE.maxBytes },
        });

        expect(block.entries).toHaveLength(2);
        expect(block.drained).toBe(false);
      });
    });

    it("sets the block cursor to the last selected entry on a partial block", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 5);

        const block = await planBlock(db, {
          after: { rev: 0, path: null },
          through: { rev: currentRev(db), path: null },
          profile: { maxEntries: 2, maxBytes: MIN_BLOCK_PROFILE.maxBytes },
        });

        const last = block.entries[block.entries.length - 1];
        expect(block.cursor).toEqual({ rev: last.rev, path: last.path });
      });
    });

    it("resumes exactly where the previous block stopped, with no gap or repeat", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 5);
        const through = { rev: currentRev(db), path: null };
        const profile = { maxEntries: 2, maxBytes: MIN_BLOCK_PROFILE.maxBytes };

        const collected: string[] = [];
        let after = { rev: 0, path: null as string | null };
        for (let i = 0; i < 10; i++) {
          const block = await planBlock(db, { after, through, profile });
          collected.push(...block.entries.map((e) => e.path));
          if (block.drained) break;
          after = block.cursor;
        }

        expect(collected).toEqual([
          "/f0000.txt",
          "/f0001.txt",
          "/f0002.txt",
          "/f0003.txt",
          "/f0004.txt",
        ]);
      });
    });

    it("produces an identical block when the same request is replayed", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 5);
        const request = {
          after: { rev: 0, path: null },
          through: { rev: currentRev(db), path: null },
          profile: { maxEntries: 3, maxBytes: MIN_BLOCK_PROFILE.maxBytes },
        };

        const first = await planBlock(db, request);
        const replay = await planBlock(db, request);

        expect(replay.entries).toEqual(first.entries);
        expect(replay.cursor).toEqual(first.cursor);
      });
    });

    it("never selects an entry beyond the fixed target", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 2);
        // The target is fixed here, before the late write lands.
        const target = { rev: currentRev(db), path: null };
        // A change created above the target must not join this block.
        await writeFile(db, "/late.txt", "late", {}, () => 99);

        const block = await planBlock(db, {
          after: { rev: 0, path: null },
          through: target,
          profile: MIN_BLOCK_PROFILE,
        });

        expect(block.entries.map((e) => e.path)).not.toContain("/late.txt");
      });
    });
  });

  describe("byte bound", () => {
    it("stops once the unique object bytes exceed the profile", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 4, 1000);

        const block = await planBlock(db, {
          after: { rev: 0, path: null },
          through: { rev: currentRev(db), path: null },
          profile: { maxEntries: 1000, maxBytes: 2500 },
        });

        expect(block.entries.length).toBeLessThan(4);
        expect(block.drained).toBe(false);
      });
    });

    // Otherwise a file larger than the byte budget would be selected
    // into an empty block, rejected for being too big, and retried
    // forever at the same cursor.
    it("allows the first entry to exceed the byte limit so a large file still progresses", async () => {
      await withDB(async (db) => {
        await writeFile(db, "/big.bin", "x".repeat(5000), {}, () => 1);

        const block = await planBlock(db, {
          after: { rev: 0, path: null },
          through: { rev: currentRev(db), path: null },
          profile: { maxEntries: 1000, maxBytes: 100 },
        });

        expect(block.entries.map((e) => e.path)).toEqual(["/big.bin"]);
      });
    });

    it("counts a duplicated object once within a block", async () => {
      await withDB(async (db) => {
        // Same content at two paths shares one hash, so the block
        // carries the bytes once even though it carries two entries.
        await writeFile(db, "/a.txt", "y".repeat(1000), {}, () => 1);
        await writeFile(db, "/b.txt", "y".repeat(1000), {}, () => 2);

        const block = await planBlock(db, {
          after: { rev: 0, path: null },
          through: { rev: currentRev(db), path: null },
          profile: { maxEntries: 1000, maxBytes: 1500 },
        });

        expect(block.entries).toHaveLength(2);
        expect(block.objectBytes).toBe(1000);
        expect(block.objects).toHaveLength(1);
      });
    });
  });

  describe("deletions", () => {
    it("carries a tombstone as an entry with no object bytes", async () => {
      await withDB(async (db) => {
        await writeFile(db, "/gone.txt", "bye", {}, () => 1);
        rm(db, "/gone.txt", {});

        const block = await planBlock(db, {
          after: { rev: 0, path: null },
          through: { rev: currentRev(db), path: null },
          profile: MIN_BLOCK_PROFILE,
        });

        expect(block.entries.map((e) => e.kind)).toEqual(["delete"]);
        expect(block.objectBytes).toBe(0);
      });
    });
  });

  describe("mode selection", () => {
    it("chooses entry mode for a small window", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 3);

        const decision = await selectMode(db, {
          after: { rev: 0, path: null },
          through: { rev: currentRev(db), path: null },
          profile: MIN_BLOCK_PROFILE,
        });

        expect(decision.mode).toBe("entries");
      });
    });

    it("chooses pack mode once the entry threshold is reached", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 12);

        const decision = await selectMode(db, {
          after: { rev: 0, path: null },
          through: { rev: currentRev(db), path: null },
          profile: MIN_BLOCK_PROFILE,
          // Injected so the test does not have to write 20,000 files
          // to reach the production threshold.
          thresholdEntries: 10,
        });

        expect(decision.mode).toBe("pack");
      });
    });

    it("chooses pack mode once the payload threshold is reached", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 4, 1000);

        const decision = await selectMode(db, {
          after: { rev: 0, path: null },
          through: { rev: currentRev(db), path: null },
          profile: MIN_BLOCK_PROFILE,
          thresholdBytes: 2000,
        });

        expect(decision.mode).toBe("pack");
      });
    });

    it("keeps the production thresholds at the planned values", () => {
      expect(PACK_THRESHOLD_ENTRIES).toBe(20_000);
      expect(PACK_THRESHOLD_BYTES).toBe(100 * 1024 * 1024);
    });

    // Q3: one planning pass has to answer the mode question and
    // produce the first block, or a large sync pays for two scans of
    // the same window before it transfers anything.
    it("returns the first block alongside the mode decision", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 3);

        const decision = await selectMode(db, {
          after: { rev: 0, path: null },
          through: { rev: currentRev(db), path: null },
          profile: MIN_BLOCK_PROFILE,
        });

        expect(decision.firstBlock.entries.map((e) => e.path)).toEqual([
          "/f0000.txt",
          "/f0001.txt",
          "/f0002.txt",
        ]);
      });
    });

    it("does not select a mode from entries beyond the target", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 3);
        const target = { rev: currentRev(db), path: null };
        // 12 more changes land above the target; they must not push
        // this operation into pack mode.
        for (let i = 0; i < 12; i++) {
          await writeFile(db, `/late${i}.txt`, "late", {}, () => 100 + i);
        }

        const decision = await selectMode(db, {
          after: { rev: 0, path: null },
          through: target,
          profile: MIN_BLOCK_PROFILE,
          thresholdEntries: 10,
        });

        expect(decision.mode).toBe("entries");
      });
    });
  });
});
