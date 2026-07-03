import { describe, expect, it } from "vitest";
import { applyChangesSync } from "../sync/apply.js";
import { link } from "./link.js";
import { mkdir } from "./mkdir.js";
import { rename } from "./rename.js";
import { resolveInode } from "./resolve.js";
import { invalidateResolveExact } from "./resolveCache.js";
import { rm } from "./rm.js";
import { symlink } from "./symlink.js";
import { withDB } from "./with-db.js";
import { writeFileSync } from "./writeFile.js";

const NOW = (): number => 1000;

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// These prove the path->inode cache never serves a stale result across
// every mutation shape, and that the recursive-CTE resolve's symlink
// fallback matches the per-component loop. They run under both backends
// (node:sqlite and real DO SqlStorage) via withDB, so cache correctness
// is exercised on the shipping storage.
describe("resolve cache + CTE resolve", () => {
  it("drops a negative entry the instant the path is created", async () => {
    await withDB(async (db) => {
      mkdir(db, "/d", { recursive: true }, NOW);
      // Prime a negative entry.
      expect(resolveInode(db, "/d/f")).toBeNull();
      writeFileSync(db, "/d/f", bytesOf("x"), {}, NOW);
      // Must resolve to the new inode, not a stale ENOENT.
      expect(resolveInode(db, "/d/f")?.type).toBe("file");
    });
  });

  it("invalidates a positive entry on unlink, rename, and rmdir", async () => {
    await withDB(async (db) => {
      mkdir(db, "/p", { recursive: true }, NOW);

      writeFileSync(db, "/p/a", bytesOf("a"), {}, NOW);
      expect(resolveInode(db, "/p/a")?.inode).toBeGreaterThan(0); // prime
      rm(db, "/p/a", {});
      expect(resolveInode(db, "/p/a")).toBeNull();

      writeFileSync(db, "/p/b", bytesOf("b"), {}, NOW);
      expect(resolveInode(db, "/p/b")).not.toBeNull(); // prime
      rename(db, "/p/b", "/p/c");
      expect(resolveInode(db, "/p/b")).toBeNull();
      expect(resolveInode(db, "/p/c")).not.toBeNull();

      mkdir(db, "/p/sub", { recursive: true }, NOW);
      expect(resolveInode(db, "/p/sub")).not.toBeNull(); // prime
      rm(db, "/p/sub", {});
      expect(resolveInode(db, "/p/sub")).toBeNull();
    });
  });

  it("invalidates every descendant path on a directory rename", async () => {
    await withDB(async (db) => {
      mkdir(db, "/src/inner", { recursive: true }, NOW);
      writeFileSync(db, "/src/inner/deep.txt", bytesOf("d"), {}, NOW);
      // Prime positives for the whole chain.
      const deepInode = resolveInode(db, "/src/inner/deep.txt")?.inode;
      expect(resolveInode(db, "/src/inner")).not.toBeNull();
      expect(deepInode).toBeGreaterThan(0);

      rename(db, "/src", "/dst");

      // Old descendant paths must be gone, not stale positives.
      expect(resolveInode(db, "/src/inner/deep.txt")).toBeNull();
      expect(resolveInode(db, "/src/inner")).toBeNull();
      expect(resolveInode(db, "/src")).toBeNull();
      // New paths resolve; the moved file keeps its inode.
      expect(resolveInode(db, "/dst/inner/deep.txt")?.inode).toBe(deepInode);
    });
  });

  it("resolves a hardlink's second name to the shared inode", async () => {
    await withDB(async (db) => {
      mkdir(db, "/h", { recursive: true }, NOW);
      writeFileSync(db, "/h/a", bytesOf("shared"), {}, NOW);
      const inode = resolveInode(db, "/h/a")?.inode;
      // Prime a negative for the not-yet-existing link path.
      expect(resolveInode(db, "/h/b")).toBeNull();
      link(db, "/h/a", "/h/b");
      expect(resolveInode(db, "/h/b")?.inode).toBe(inode);
    });
  });

  it("reflects a sync-applied change through cached negative and positive paths", async () => {
    await withDB(async (db) => {
      mkdir(db, "/s", { recursive: true }, NOW);
      writeFileSync(db, "/s/existing", bytesOf("e"), {}, NOW);
      // Prime: negative for a dir we will create, positive for a file we
      // will delete.
      expect(resolveInode(db, "/s/newdir")).toBeNull();
      expect(resolveInode(db, "/s/existing")).not.toBeNull();

      // applyChangesSync funnels through mkdir (create) and rm (delete),
      // both of which invalidate the cache.
      applyChangesSync(
        db,
        [
          { kind: "dir", rev: 1, path: "/s/newdir", mode: 0o755, mtime: 1000 },
          { kind: "delete", rev: 2, path: "/s/existing" },
        ],
        new Map(),
      );

      expect(resolveInode(db, "/s/newdir")?.type).toBe("dir");
      expect(resolveInode(db, "/s/existing")).toBeNull();

      // Apply a symlink over a POPULATED directory: exercises apply's own
      // conflict-cleanup branch (removeReplaceableFinalEntry ->
      // removeInodeTreeAtPath subtree invalidation) plus symlink-create
      // invalidation, with a primed descendant positive.
      mkdir(db, "/s/dir/child", { recursive: true }, NOW);
      expect(resolveInode(db, "/s/dir/child")).not.toBeNull();
      expect(resolveInode(db, "/s/dir")?.type).toBe("dir");
      applyChangesSync(
        db,
        [
          {
            kind: "symlink",
            rev: 3,
            path: "/s/dir",
            target: "/elsewhere",
            mode: 0o777,
            mtime: 1000,
          },
        ],
        new Map(),
      );
      // /s/dir is now a symlink; the former descendant no longer resolves.
      expect(resolveInode(db, "/s/dir", { followSymlinks: false })?.type).toBe("symlink");
      expect(resolveInode(db, "/s/dir/child")).toBeNull();
    });
  });

  it("leaves no stale entry after a rolled-back write", async () => {
    await withDB(async (db) => {
      mkdir(db, "/r", { recursive: true }, NOW);
      const rDir = resolveInode(db, "/r")?.inode ?? 0;
      writeFileSync(db, "/r/keep", bytesOf("k"), {}, NOW);
      const keepInode = resolveInode(db, "/r/keep")?.inode; // prime positive
      expect(keepInode).toBeGreaterThan(0);

      // A mutation is (structural write + cache invalidation) inside one
      // transaction. This drives that shape with raw statements at a
      // single transaction level — the DO backend forbids the nested
      // savepoints an outer db.transactionSync around an fs op would use,
      // and the cache's rollback-safety is backend-independent anyway.

      // Rolled-back delete: the invalidation drops the entry mid-txn; the
      // rollback restores the dirent; the recompute finds it alive again
      // (no stale ENOENT).
      expect(() =>
        db.transactionSync(() => {
          db.run("DELETE FROM vfs_dirents WHERE parent_inode = ? AND name = ?", rDir, "keep");
          invalidateResolveExact(db, "/r/keep");
          throw new Error("boom-delete");
        }),
      ).toThrow("boom-delete");
      expect(resolveInode(db, "/r/keep")?.inode).toBe(keepInode);

      // Rolled-back create + inode reuse: population is gated inside a
      // transaction, so the doomed inode is never cached for /r/new. A
      // broken gate would cache it and, after AUTOINCREMENT reuses the
      // number on the next committed create, alias /r/new to /r/other.
      expect(resolveInode(db, "/r/new")).toBeNull(); // prime negative
      expect(() =>
        db.transactionSync(() => {
          db.run("INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('file', 420, 0, 0)");
          const inode = db.scalar<number>("SELECT last_insert_rowid() AS v") ?? 0;
          db.run(
            "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
            rDir,
            "new",
            inode,
          );
          invalidateResolveExact(db, "/r/new");
          // Reading inside the txn must not populate the cache (the gate).
          expect(resolveInode(db, "/r/new")).not.toBeNull();
          throw new Error("boom-create");
        }),
      ).toThrow("boom-create");
      writeFileSync(db, "/r/other", bytesOf("o"), {}, NOW);
      expect(resolveInode(db, "/r/new")).toBeNull();
      expect(resolveInode(db, "/r/other")).not.toBeNull();
    });
  });

  it("falls back to the loop for symlinks, resolving identically", async () => {
    await withDB(async (db) => {
      mkdir(db, "/target/sub", { recursive: true }, NOW);
      writeFileSync(db, "/target/sub/file.txt", bytesOf("hello"), {}, NOW);
      const realInode = resolveInode(db, "/target/sub/file.txt")?.inode;

      // Intermediate symlink: /link -> /target.
      symlink(db, "/target", "/link", NOW);
      // Following through the link reaches the real file inode.
      expect(resolveInode(db, "/link/sub/file.txt")?.inode).toBe(realInode);
      // Following the link itself lands on the directory it points at.
      expect(resolveInode(db, "/link")?.type).toBe("dir");
      // lstat (no follow) lands on the symlink node itself.
      const withoutFollow = resolveInode(db, "/link", { followSymlinks: false });
      expect(withoutFollow?.type).toBe("symlink");
      expect(withoutFollow?.linkTarget).toBe("/target");

      // Dangling symlink: ENOENT when followed, symlink node when not.
      symlink(db, "/nope", "/dangling", NOW);
      expect(resolveInode(db, "/dangling")).toBeNull();
      expect(resolveInode(db, "/dangling", { followSymlinks: false })?.type).toBe("symlink");
    });
  });

  it("drops a negative primed beneath a path that a new symlink makes resolvable", async () => {
    await withDB(async (db) => {
      mkdir(db, "/target", { recursive: true }, NOW);
      writeFileSync(db, "/target/x", bytesOf("x"), {}, NOW);
      const realInode = resolveInode(db, "/target/x")?.inode;
      // Prime a negative for a path beneath where the link will land
      // (no symlink on the path yet, so the negative is cached).
      expect(resolveInode(db, "/link/x")).toBeNull();

      // Creating the symlink makes "/link/x" resolvable through it; the
      // subtree invalidation must drop the stale negative beneath it.
      symlink(db, "/target", "/link", NOW);
      expect(resolveInode(db, "/link/x")?.inode).toBe(realInode);
    });
  });

  it("does not cache a negative when a symlink on the path forces the loop", async () => {
    await withDB(async (db) => {
      mkdir(db, "/target", { recursive: true }, NOW);
      symlink(db, "/target", "/link", NOW);
      // Resolve through the link before the leaf exists: the CTE bails
      // to the loop and must cache nothing for the aliased path.
      expect(resolveInode(db, "/link/x")).toBeNull();

      // Create the real leaf. This invalidates "/target/x", not the
      // "/link/x" alias — so a negative wrongly cached by the bail would
      // linger and this read would still see null.
      writeFileSync(db, "/target/x", bytesOf("x"), {}, NOW);
      expect(resolveInode(db, "/link/x")?.type).toBe("file");
    });
  });
});
