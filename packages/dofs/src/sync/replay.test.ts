import { describe, expect, it } from "vitest";

import { chmod } from "../fs/chmod.js";
import { link } from "../fs/link.js";
import { mkdir } from "../fs/mkdir.js";
import { readFile } from "../fs/readFile.js";
import { rename } from "../fs/rename.js";
import { resolveInode } from "../fs/resolve.js";
import { withDB } from "../fs/with-db.js";
import { writeFile } from "../fs/writeFile.js";
import { applyChanges, applyChangesSync } from "./apply.js";
import type { ChangeEntry } from "./changes.js";
import { fingerprintVersion, versionFingerprint } from "./fingerprint.js";
import { computeManifestHash } from "./manifests.js";
import { currentRev, writePushCursor, writeWatermark } from "./watermarks.js";

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

    for (const [name, apply] of [
      ["async", applyChanges],
      ["sync", applyChangesSync],
    ] as const) {
      // Across apply calls, a delete without a fingerprint (from a peer
      // that predates them) cannot tell a pulled version from host work.
      // The rpc layer acknowledges a clean pull, which moves the push
      // cursor over it (see "acknowledging pulled versions" in rpc).
      // Without either, the pulled copy is kept and the next push
      // recreates it remotely. See "fingerprinted deletes" below.
      it(`${name}: keeps an unacknowledged pulled file from an unfingerprinted delete`, async () => {
        await withDB(async (db) => {
          writeWatermark(db, "pushRev", currentRev(db));
          const file: ChangeEntry = {
            kind: "file",
            rev: 1,
            path: "/pulled/x",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          };
          expect((await apply(db, [file], new Map(), { source: "upstream" })).applied).toBe(1);
          const result = await apply(
            db,
            [{ kind: "delete", rev: 2, path: "/pulled/x" }],
            new Map(),
            { source: "upstream" },
          );
          expect(result.applied).toBe(0);
          expect(resolveInode(db, "/pulled/x", { followSymlinks: false })).not.toBeNull();
        });
      });

      it(`${name}: reports the revs it minted`, async () => {
        await withDB(async (db) => {
          const before = currentRev(db);
          const file: ChangeEntry = {
            kind: "file",
            rev: 1,
            path: "/a/b/x",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          };
          const result = await apply(db, [file], new Map(), { source: "upstream" });
          expect(result.minted).toBe(currentRev(db) - before);
          expect(result.minted).toBeGreaterThan(0);
          const again = await apply(db, [file], new Map(), { source: "upstream" });
          expect(again.minted).toBe(0);
        });
      });

      it(`${name}: protects a local edit made after a pull`, async () => {
        await withDB(async (db) => {
          writeWatermark(db, "pushRev", currentRev(db));
          const file: ChangeEntry = {
            kind: "file",
            rev: 1,
            path: "/x",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          };
          await apply(db, [file], new Map(), { source: "upstream" });
          await writeFile(db, "/x", "local edit", {}, () => 2);
          const result = await apply(db, [{ kind: "delete", rev: 2, path: "/x" }], new Map(), {
            source: "upstream",
          });
          expect(result.applied).toBe(0);
          expect(await readFile(db, "/x", "utf8")).toBe("local edit");
        });
      });

      it(`${name}: protects unpushed descendants from a directory delete`, async () => {
        await withDB(async (db) => {
          mkdir(db, "/project", {}, () => 1);
          await writeFile(db, "/project/draft", "pushed", {}, () => 1);
          writeWatermark(db, "pushRev", currentRev(db));
          await writeFile(db, "/project/draft", "unpushed", {}, () => 2);
          const result = await apply(
            db,
            [{ kind: "delete", rev: 1, path: "/project" }],
            new Map(),
            {
              source: "upstream",
            },
          );
          expect(result.applied).toBe(0);
          expect(await readFile(db, "/project/draft", "utf8")).toBe("unpushed");
        });
      });

      it(`${name}: still deletes a clean directory tree`, async () => {
        await withDB(async (db) => {
          mkdir(db, "/project", {}, () => 1);
          await writeFile(db, "/project/done", "pushed", {}, () => 1);
          writeWatermark(db, "pushRev", currentRev(db));
          const result = await apply(
            db,
            [{ kind: "delete", rev: 1, path: "/project" }],
            new Map(),
            {
              source: "upstream",
            },
          );
          expect(result.applied).toBe(1);
          expect(resolveInode(db, "/project", { followSymlinks: false })).toBeNull();
        });
      });

      it(`${name}: protects same-rev paths beyond a partial push cursor`, async () => {
        await withDB(async (db) => {
          mkdir(db, "/old", {}, () => 1);
          await writeFile(db, "/old/a", "a", {}, () => 1);
          await writeFile(db, "/old/b", "b", {}, () => 1);
          rename(db, "/old", "/new");
          const renameRev = currentRev(db);
          // A bounded push shipped /new and /new/a, but not /new/b.
          writePushCursor(db, { rev: renameRev, path: "/new/a" });
          const unshipped = await apply(
            db,
            [{ kind: "delete", rev: 1, path: "/new/b" }],
            new Map(),
            {
              source: "upstream",
            },
          );
          expect(unshipped.applied).toBe(0);
          expect(await readFile(db, "/new/b", "utf8")).toBe("b");
          const shipped = await apply(db, [{ kind: "delete", rev: 1, path: "/new/a" }], new Map(), {
            source: "upstream",
          });
          expect(shipped.applied).toBe(1);
          expect(resolveInode(db, "/new/a", { followSymlinks: false })).toBeNull();
        });
      });
      it(`${name}: keeps an unpushed hardlink when a pull rewrites its inode`, async () => {
        await withDB(async (db) => {
          await writeFile(db, "/x", "content", {}, () => 1);
          writeWatermark(db, "pushRev", currentRev(db));
          link(db, "/x", "/y");
          // The pull rewrites /x, which shares its inode with the
          // unpushed /y, then deletes /y.
          const update: ChangeEntry = {
            kind: "file",
            rev: 7,
            path: "/x",
            mode: 0o644,
            mtime: 2,
            size: 0,
            chunks: [],
          };
          const result = await apply(
            db,
            [update, { kind: "delete", rev: 8, path: "/y" }],
            new Map(),
            { source: "upstream" },
          );
          expect(result.applied).toBe(1);
          expect(resolveInode(db, "/y", { followSymlinks: false })).not.toBeNull();
        });
      });

      // The pull rewrote /x while /y, a fresh link to the same inode,
      // was unpushed. The shared inode now holds an unpushed version, so
      // without a fingerprint on the delete it stays protected: deleting
      // a name cannot be told apart from discarding the link's version.
      // With one, the delete applies; see "fingerprinted deletes".
      it(`${name}: keeps a rewritten name beside an unpushed hardlink without a fingerprint`, async () => {
        await withDB(async (db) => {
          await writeFile(db, "/x", "content", {}, () => 1);
          writeWatermark(db, "pushRev", currentRev(db));
          link(db, "/x", "/y");
          const update: ChangeEntry = {
            kind: "file",
            rev: 7,
            path: "/x",
            mode: 0o644,
            mtime: 2,
            size: 0,
            chunks: [],
          };
          expect((await apply(db, [update], new Map(), { source: "upstream" })).applied).toBe(1);
          const second = await apply(db, [{ kind: "delete", rev: 8, path: "/x" }], new Map(), {
            source: "upstream",
          });
          expect(second.applied).toBe(0);
          expect(resolveInode(db, "/x", { followSymlinks: false })).not.toBeNull();
          expect(resolveInode(db, "/y", { followSymlinks: false })).not.toBeNull();
        });
      });

      it(`${name}: still protects a local edit after a pull rewrites a hardlinked name`, async () => {
        await withDB(async (db) => {
          await writeFile(db, "/x", "content", {}, () => 1);
          writeWatermark(db, "pushRev", currentRev(db));
          link(db, "/x", "/y");
          const update: ChangeEntry = {
            kind: "file",
            rev: 7,
            path: "/x",
            mode: 0o644,
            mtime: 2,
            size: 0,
            chunks: [],
          };
          await apply(db, [update], new Map(), { source: "upstream" });
          await writeFile(db, "/x", "edited", {}, () => 3);
          const result = await apply(db, [{ kind: "delete", rev: 8, path: "/x" }], new Map(), {
            source: "upstream",
          });
          expect(result.applied).toBe(0);
          expect(await readFile(db, "/x", "utf8")).toBe("edited");
        });
      });

      it(`${name}: still deletes a pushed hardlink after a pull rewrites its inode`, async () => {
        await withDB(async (db) => {
          await writeFile(db, "/x", "content", {}, () => 1);
          link(db, "/x", "/y");
          writeWatermark(db, "pushRev", currentRev(db));
          const update: ChangeEntry = {
            kind: "file",
            rev: 7,
            path: "/x",
            mode: 0o644,
            mtime: 2,
            size: 0,
            chunks: [],
          };
          const result = await apply(
            db,
            [update, { kind: "delete", rev: 8, path: "/y" }],
            new Map(),
            { source: "upstream" },
          );
          expect(result.applied).toBe(2);
          expect(resolveInode(db, "/y", { followSymlinks: false })).toBeNull();
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

// A delete may carry the fingerprint of the version the sender removed
// (`prior`). A pulled delete then applies when the backend has seen the
// local version (the push cursor covers it) or when the local version
// is exactly the one the backend deleted, since removing it loses
// nothing the backend never had. It is kept only when the local version
// is both unseen and different. Deletes without a fingerprint, from an
// older peer, use the cursor rule alone.
describe("fingerprinted deletes", () => {
  const EMPTY_FILE = fingerprintVersion({
    type: "file",
    mode: 0o644,
    manifest: computeManifestHash([]),
  });
  const pulledFile = (path: string, rev = 1): ChangeEntry => ({
    kind: "file",
    rev,
    path,
    mode: 0o644,
    mtime: 1,
    size: 0,
    chunks: [],
  });

  for (const [name, apply] of [
    ["async", applyChanges],
    ["sync", applyChangesSync],
  ] as const) {
    it(`${name}: removes an unacknowledged pulled file`, async () => {
      await withDB(async (db) => {
        writeWatermark(db, "pushRev", currentRev(db));
        await apply(db, [pulledFile("/pulled/x")], new Map(), { source: "upstream" });
        const result = await apply(
          db,
          [{ kind: "delete", rev: 2, path: "/pulled/x", prior: EMPTY_FILE }],
          new Map(),
          { source: "upstream" },
        );
        expect(result.applied).toBe(1);
        expect(resolveInode(db, "/pulled/x", { followSymlinks: false })).toBeNull();
      });
    });

    it(`${name}: keeps a local edit the fingerprint does not describe`, async () => {
      await withDB(async (db) => {
        writeWatermark(db, "pushRev", currentRev(db));
        await apply(db, [pulledFile("/x")], new Map(), { source: "upstream" });
        await writeFile(db, "/x", "local edit", {}, () => 2);
        const result = await apply(
          db,
          [{ kind: "delete", rev: 2, path: "/x", prior: EMPTY_FILE }],
          new Map(),
          { source: "upstream" },
        );
        expect(result.applied).toBe(0);
        expect(await readFile(db, "/x", "utf8")).toBe("local edit");
      });
    });

    it(`${name}: keeps a local chmod the fingerprint does not describe`, async () => {
      await withDB(async (db) => {
        writeWatermark(db, "pushRev", currentRev(db));
        await apply(db, [pulledFile("/x")], new Map(), { source: "upstream" });
        chmod(db, "/x", 0o600, () => 2);
        const result = await apply(
          db,
          [{ kind: "delete", rev: 2, path: "/x", prior: EMPTY_FILE }],
          new Map(),
          { source: "upstream" },
        );
        expect(result.applied).toBe(0);
        expect(resolveInode(db, "/x", { followSymlinks: false })).not.toBeNull();
      });
    });

    it(`${name}: removes the rewritten name beside an unpushed hardlink`, async () => {
      await withDB(async (db) => {
        await writeFile(db, "/x", "content", {}, () => 1);
        writeWatermark(db, "pushRev", currentRev(db));
        link(db, "/x", "/y");
        await apply(db, [pulledFile("/x", 7)], new Map(), { source: "upstream" });
        const second = await apply(
          db,
          [{ kind: "delete", rev: 8, path: "/x", prior: EMPTY_FILE }],
          new Map(),
          { source: "upstream" },
        );
        expect(second.applied).toBe(1);
        expect(resolveInode(db, "/x", { followSymlinks: false })).toBeNull();
        // /y is an unpushed name the backend never had; a delete of it
        // without a fingerprint stays blocked.
        expect(resolveInode(db, "/y", { followSymlinks: false })).not.toBeNull();
        const third = await apply(db, [{ kind: "delete", rev: 9, path: "/y" }], new Map(), {
          source: "upstream",
        });
        expect(third.applied).toBe(0);
      });
    });

    it(`${name}: removes an unacknowledged pulled directory once its children go`, async () => {
      await withDB(async (db) => {
        writeWatermark(db, "pushRev", currentRev(db));
        await apply(db, [pulledFile("/d/f")], new Map(), { source: "upstream" });
        const dirMode = resolveInode(db, "/d", { followSymlinks: false })?.mode ?? 0;
        // A recursive rm in the container tombstones every path; the
        // directory sorts first, so it is decided after its children.
        const result = await apply(
          db,
          [
            {
              kind: "delete",
              rev: 3,
              path: "/d",
              prior: fingerprintVersion({ type: "dir", mode: dirMode }),
            },
            { kind: "delete", rev: 3, path: "/d/f", prior: EMPTY_FILE },
          ],
          new Map(),
          { source: "upstream" },
        );
        expect(result.applied).toBe(2);
        expect(resolveInode(db, "/d", { followSymlinks: false })).toBeNull();
      });
    });

    it(`${name}: keeps a pulled directory that still holds unseen host work`, async () => {
      await withDB(async (db) => {
        writeWatermark(db, "pushRev", currentRev(db));
        await apply(db, [pulledFile("/d/f")], new Map(), { source: "upstream" });
        await writeFile(db, "/d/mine", "host work", {}, () => 2);
        const dirMode = resolveInode(db, "/d", { followSymlinks: false })?.mode ?? 0;
        const result = await apply(
          db,
          [
            {
              kind: "delete",
              rev: 3,
              path: "/d",
              prior: fingerprintVersion({ type: "dir", mode: dirMode }),
            },
            { kind: "delete", rev: 3, path: "/d/f", prior: EMPTY_FILE },
          ],
          new Map(),
          { source: "upstream" },
        );
        expect(result.applied).toBe(1);
        expect(resolveInode(db, "/d/f", { followSymlinks: false })).toBeNull();
        expect(await readFile(db, "/d/mine", "utf8")).toBe("host work");
      });
    });

    // Known trade-off, pinned so a change to it is deliberate. A pull
    // block that applied a fingerprinted delete and died before its
    // fetch cursor moved is replayed. If the host recreated the path
    // with identical bytes in between, the fingerprint matches and the
    // replay removes the recreation. Closing this needs the pull's
    // apply and its cursor checkpoint to commit together.
    it(`${name}: a replayed fingerprinted delete removes an identical recreation`, async () => {
      await withDB(async (db) => {
        await writeFile(db, "/x", "same", { mode: 0o644 }, () => 1);
        writeWatermark(db, "pushRev", currentRev(db));
        const live = resolveInode(db, "/x", { followSymlinks: false });
        const prior = versionFingerprint(db, live?.inode ?? 0);
        const tombstone: ChangeEntry = { kind: "delete", rev: 4, path: "/x", prior };
        await apply(db, [tombstone], new Map(), { source: "upstream" });
        await writeFile(db, "/x", "same", { mode: 0o644 }, () => 2);
        const replay = await apply(db, [tombstone], new Map(), { source: "upstream" });
        expect(replay.applied).toBe(1);
        expect(resolveInode(db, "/x", { followSymlinks: false })).toBeNull();
      });
    });

    it(`${name}: push receivers keep the replay rule and ignore the fingerprint`, async () => {
      await withDB(async (db) => {
        await writeFile(db, "/x", "same", { mode: 0o644 }, () => 1);
        const live = resolveInode(db, "/x", { followSymlinks: false });
        const prior = versionFingerprint(db, live?.inode ?? 0);
        const tombstone: ChangeEntry = { kind: "delete", rev: 4, path: "/x", prior };
        await apply(db, [tombstone], new Map(), {
          source: "upstream",
          receivedCursor: { rev: 0, path: null },
        });
        await writeFile(db, "/x", "same", { mode: 0o644 }, () => 2);
        const replay = await apply(db, [tombstone], new Map(), {
          source: "upstream",
          receivedCursor: { rev: 4, path: "/x" },
        });
        expect(replay.applied).toBe(0);
        expect(await readFile(db, "/x", "utf8")).toBe("same");
      });
    });
  }
});
