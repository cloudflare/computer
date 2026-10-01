import { describe, expect, it } from "vitest";

import { readFile } from "../fs/readFile.js";
import { resolveInode } from "../fs/resolve.js";
import { withDB } from "../fs/with-db.js";
import { writeFile } from "../fs/writeFile.js";
import { applyChanges, applyChangesSync } from "./apply.js";
import type { ChangeEntry } from "./changes.js";
import { currentRev, writeWatermark } from "./watermarks.js";

// The unified sync plan asserts that replaying an unacknowledged block
// is safe because "revision and cursor semantics already make replay
// idempotent". That assertion is load-bearing: the cursor only
// advances after a block applies, so any block interrupted before its
// acknowledgment is re-applied on the next iterator. These tests
// enumerate what idempotent actually means per entry kind instead of
// taking it on faith.
//
// The dangerous case is a tombstone. A file entry replays to identical
// content, but a delete replayed after the path was locally recreated
// would destroy data that the tombstone never described.

describe("block replay idempotency", () => {
  describe("write entries", () => {
    it("applies a file entry twice with the same result", async () => {
      await withDB(async (db) => {
        const entry: ChangeEntry = {
          kind: "dir",
          rev: 5,
          path: "/dir",
          mode: 0o755,
          mtime: 1000,
        };

        const first = await applyChanges(db, [entry], new Map(), { source: "upstream" });
        const second = await applyChanges(db, [entry], new Map(), { source: "upstream" });

        expect(first.applied).toBe(1);
        // The second pass recognises the entry as already in place and
        // does no work, which is what stops a replayed block from
        // bumping rev and re-triggering a push.
        expect(second.applied).toBe(0);
        expect(resolveInode(db, "/dir", { followSymlinks: false })?.type).toBe("dir");
      });
    });

    it("applies a symlink entry twice with the same result", async () => {
      await withDB(async (db) => {
        const entry: ChangeEntry = {
          kind: "symlink",
          rev: 5,
          path: "/link",
          target: "/target",
          mode: 0o777,
          mtime: 1000,
        };

        await applyChanges(db, [entry], new Map(), { source: "upstream" });
        const second = await applyChanges(db, [entry], new Map(), { source: "upstream" });

        expect(second.applied).toBe(0);
        expect(resolveInode(db, "/link", { followSymlinks: false })?.linkTarget).toBe("/target");
      });
    });
  });

  describe("delete entries", () => {
    it("applies a tombstone twice without error when the path stays gone", async () => {
      await withDB(async (db) => {
        await writeFile(db, "/gone.txt", "bye", {}, () => 1);
        writeWatermark(db, "pushRev", currentRev(db));
        const entry: ChangeEntry = { kind: "delete", rev: 5, path: "/gone.txt" };

        await applyChanges(db, [entry], new Map(), { source: "upstream" });
        const second = await applyChanges(db, [entry], new Map(), { source: "upstream" });

        expect(second.skipped).toEqual([]);
        expect(resolveInode(db, "/gone.txt", { followSymlinks: false })).toBeNull();
      });
    });

    it("does not delete an unpushed recreation on replay", async () => {
      await withDB(async (db) => {
        await writeFile(db, "/data.txt", "original", {}, () => 1);
        writeWatermark(db, "pushRev", currentRev(db));
        const tombstone: ChangeEntry = { kind: "delete", rev: 9_999, path: "/data.txt" };

        // The block applied the tombstone but died before it could
        // acknowledge its cursor.
        await applyChanges(db, [tombstone], new Map(), { source: "upstream" });
        expect(resolveInode(db, "/data.txt", { followSymlinks: false })).toBeNull();

        // A local write recreates the path above the local push watermark.
        await writeFile(db, "/data.txt", "recreated", {}, () => 2);
        const liveRev =
          db.one<{ rev: number }>(
            "SELECT rev FROM vfs_nodes WHERE inode = ?",
            resolveInode(db, "/data.txt", { followSymlinks: false })?.inode ?? 0,
          )?.rev ?? 0;
        expect(liveRev).toBeGreaterThan(1);

        // The interrupted block is replayed from the durable cursor.
        const replay = await applyChanges(db, [tombstone], new Map(), { source: "upstream" });

        expect(resolveInode(db, "/data.txt", { followSymlinks: false })).not.toBeNull();
        expect(await readFile(db, "/data.txt", "utf8")).toBe("recreated");
        expect(replay.applied).toBe(0);
      });
    });

    it("deletes a pushed path even when the peer revision is smaller", async () => {
      await withDB(async (db) => {
        await writeFile(db, "/stale.txt", "stale", {}, () => 1);
        await writeFile(db, "/stale.txt", "newer", {}, () => 2);
        writeWatermark(db, "pushRev", currentRev(db));
        const tombstone: ChangeEntry = { kind: "delete", rev: 1, path: "/stale.txt" };

        const result = await applyChanges(db, [tombstone], new Map(), { source: "upstream" });

        expect(result.applied).toBe(1);
        expect(resolveInode(db, "/stale.txt", { followSymlinks: false })).toBeNull();
      });
    });

    for (const [name, apply] of [
      ["async", applyChanges],
      ["sync", applyChangesSync],
    ] as const) {
      it(`${name}: uses only the selected backend's push watermark`, async () => {
        await withDB(async (db) => {
          await writeFile(db, "/x", "content", {}, () => 1);
          writeWatermark(db, "pushRev", currentRev(db), "other");
          const entry: ChangeEntry = { kind: "delete", rev: 9_999, path: "/x" };
          expect(
            (await apply(db, [entry], new Map(), { source: "upstream", backend: "linux" })).applied,
          ).toBe(0);
          writeWatermark(db, "pushRev", currentRev(db), "linux");
          expect(
            (
              await apply(db, [{ ...entry, rev: 1 }], new Map(), {
                source: "upstream",
                backend: "linux",
              })
            ).applied,
          ).toBe(1);
        });
      });

      it(`${name}: protects unpushed edits after a watermark reset`, async () => {
        await withDB(async (db) => {
          await writeFile(db, "/x", "content", {}, () => 1);
          writeWatermark(db, "pushRev", currentRev(db));
          writeWatermark(db, "pushRev", 0);
          const result = await apply(db, [{ kind: "delete", rev: 9_999, path: "/x" }], new Map(), {
            source: "upstream",
          });
          expect(result.applied).toBe(0);
          expect(await readFile(db, "/x", "utf8")).toBe("content");
        });
      });

      it(`${name}: accepts new pushes but protects recreations from committed replays`, async () => {
        await withDB(async (db) => {
          await writeFile(db, "/x", "original", {}, () => 1);
          await writeFile(db, "/x", "updated", {}, () => 2);
          const entry: ChangeEntry = { kind: "delete", rev: 1, path: "/x" };
          const first = await apply(db, [entry], new Map(), {
            source: "upstream",
            receivedCursor: { rev: 0, path: null },
          });
          expect(first.applied).toBe(1);
          await writeFile(db, "/x", "recreated", {}, () => 3);
          const replay = await apply(db, [entry], new Map(), {
            source: "upstream",
            receivedCursor: { rev: 1, path: "/x" },
          });
          expect(replay.applied).toBe(0);
          expect(await readFile(db, "/x", "utf8")).toBe("recreated");
          // A later path within the same sender rev is not a replay.
          expect(
            (
              await apply(db, [{ ...entry, path: "/z" }], new Map(), {
                source: "upstream",
                receivedCursor: { rev: 1, path: "/x" },
              })
            ).applied,
          ).toBe(1);
        });
      });
    }

    // A locally-authored delete is not a replay of remote state, so
    // the revision guard must not apply to it.
    it("applies a local tombstone regardless of the live revision", async () => {
      await withDB(async (db) => {
        await writeFile(db, "/local.txt", "content", {}, () => 1);
        const tombstone: ChangeEntry = { kind: "delete", rev: 1, path: "/local.txt" };

        const result = await applyChanges(db, [tombstone], new Map(), { source: "local" });

        expect(result.applied).toBe(1);
        expect(resolveInode(db, "/local.txt", { followSymlinks: false })).toBeNull();
      });
    });
  });
});
