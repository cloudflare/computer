import { describe, expect, it } from "vitest";

import { readFile } from "../fs/readFile.js";
import { resolveInode } from "../fs/resolve.js";
import { withDB } from "../fs/with-db.js";
import { writeFile } from "../fs/writeFile.js";
import { applyChanges } from "./apply.js";
import type { ChangeEntry } from "./changes.js";

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
        const entry: ChangeEntry = { kind: "delete", rev: 5, path: "/gone.txt" };

        await applyChanges(db, [entry], new Map(), { source: "upstream" });
        const second = await applyChanges(db, [entry], new Map(), { source: "upstream" });

        expect(second.skipped).toEqual([]);
        expect(resolveInode(db, "/gone.txt", { followSymlinks: false })).toBeNull();
      });
    });

    // The plan's idempotency claim breaks here. The tombstone was
    // produced at rev 5 and describes the file as it was then. If the
    // block carrying it is interrupted before acknowledgment and the
    // path is recreated locally in the meantime, replaying the
    // tombstone deletes content it never described.
    it("does not delete a path recreated at a newer revision than the tombstone", async () => {
      await withDB(async (db) => {
        await writeFile(db, "/data.txt", "original", {}, () => 1);
        // The tombstone's rev is whatever the source stamped it with.
        // What matters is that the local recreation lands above it.
        const tombstone: ChangeEntry = { kind: "delete", rev: 2, path: "/data.txt" };

        // The block applied the tombstone but died before it could
        // acknowledge its cursor.
        await applyChanges(db, [tombstone], new Map(), { source: "upstream" });
        expect(resolveInode(db, "/data.txt", { followSymlinks: false })).toBeNull();

        // A local write recreates the path at a revision above the
        // tombstone's.
        await writeFile(db, "/data.txt", "recreated", {}, () => 2);
        const liveRev =
          db.one<{ rev: number }>(
            "SELECT rev FROM vfs_nodes WHERE inode = ?",
            resolveInode(db, "/data.txt", { followSymlinks: false })?.inode ?? 0,
          )?.rev ?? 0;
        expect(liveRev).toBeGreaterThan(tombstone.rev);

        // The interrupted block is replayed from the durable cursor.
        const replay = await applyChanges(db, [tombstone], new Map(), { source: "upstream" });

        expect(resolveInode(db, "/data.txt", { followSymlinks: false })).not.toBeNull();
        expect(await readFile(db, "/data.txt", "utf8")).toBe("recreated");
        expect(replay.applied).toBe(0);
      });
    });

    it("still deletes a path whose live revision predates the tombstone", async () => {
      await withDB(async (db) => {
        await writeFile(db, "/stale.txt", "stale", {}, () => 1);
        // A tombstone from far above the live rev is a genuine delete
        // the receiver has not seen yet.
        const tombstone: ChangeEntry = { kind: "delete", rev: 9_999, path: "/stale.txt" };

        const result = await applyChanges(db, [tombstone], new Map(), { source: "upstream" });

        expect(result.applied).toBe(1);
        expect(resolveInode(db, "/stale.txt", { followSymlinks: false })).toBeNull();
      });
    });

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
