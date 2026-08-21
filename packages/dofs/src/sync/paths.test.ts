import { describe, expect, it } from "vitest";

import { link } from "../fs/link.js";
import { mkdir } from "../fs/mkdir.js";
import { withDB } from "../fs/with-db.js";
import { writeFile } from "../fs/writeFile.js";
import { ROOT_INODE } from "../schema/index.js";
import { type pathOf, pathsOf, pathsOfMany } from "./paths.js";

// Read back the inode a path currently names. Tests need this to feed
// pathsOfMany without going through resolveInode's symlink handling.
function inodeOf(db: Parameters<typeof pathOf>[0], parentInode: number, name: string): number {
  const row = db.one<{ child_inode: number }>(
    "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
    parentInode,
    name,
  );
  if (row === undefined) throw new Error(`no dirent ${name} under ${parentInode}`);
  return row.child_inode;
}

describe("pathsOfMany", () => {
  it("returns an empty map for no inodes", async () => {
    await withDB((db) => {
      expect(pathsOfMany(db, [])).toEqual(new Map());
    });
  });

  it("maps the root inode to /", async () => {
    await withDB((db) => {
      expect(pathsOfMany(db, [ROOT_INODE])).toEqual(new Map([[ROOT_INODE, ["/"]]]));
    });
  });

  it("resolves a top-level entry", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "x", {}, () => 1);
      const inode = inodeOf(db, ROOT_INODE, "a.txt");
      expect(pathsOfMany(db, [inode])).toEqual(new Map([[inode, ["/a.txt"]]]));
    });
  });

  it("resolves a deeply nested entry", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a/b/c/d", { recursive: true }, () => 1);
      await writeFile(db, "/a/b/c/d/deep.txt", "x", {}, () => 2);
      const a = inodeOf(db, ROOT_INODE, "a");
      const b = inodeOf(db, a, "b");
      const c = inodeOf(db, b, "c");
      const d = inodeOf(db, c, "d");
      const file = inodeOf(db, d, "deep.txt");
      expect(pathsOfMany(db, [file])).toEqual(new Map([[file, ["/a/b/c/d/deep.txt"]]]));
    });
  });

  it("returns every hardlink name for an inode, sorted", async () => {
    await withDB(async (db) => {
      mkdir(db, "/dir", {}, () => 1);
      await writeFile(db, "/one.txt", "x", {}, () => 2);
      link(db, "/one.txt", "/two.txt");
      link(db, "/one.txt", "/dir/three.txt");
      const inode = inodeOf(db, ROOT_INODE, "one.txt");
      const got = pathsOfMany(db, [inode]).get(inode);
      expect([...(got ?? [])].sort()).toEqual(["/dir/three.txt", "/one.txt", "/two.txt"]);
    });
  });

  it("omits inodes that are unreachable from the root", async () => {
    await withDB((db) => {
      // 99999 has no dirent row at all.
      expect(pathsOfMany(db, [99999])).toEqual(new Map());
    });
  });

  it("resolves many inodes in one call, matching pathsOf exactly", async () => {
    await withDB(async (db) => {
      const inodes: number[] = [];
      mkdir(db, "/pkg", { recursive: true }, () => 1);
      for (let i = 0; i < 25; i++) {
        mkdir(db, `/pkg/p${i}/dist`, { recursive: true }, () => 2);
        await writeFile(db, `/pkg/p${i}/dist/index.js`, "x", {}, () => 3);
      }
      for (const row of db.all<{ inode: number }>("SELECT inode FROM vfs_nodes")) {
        inodes.push(row.inode);
      }

      const batched = pathsOfMany(db, inodes);
      for (const inode of inodes) {
        const expected = pathsOf(db, inode);
        const actual = batched.get(inode) ?? [];
        expect([...actual].sort()).toEqual([...expected].sort());
      }
    });
  });

  it("agrees with pathsOf on a tree containing hardlinks", async () => {
    await withDB(async (db) => {
      mkdir(db, "/x/y", { recursive: true }, () => 1);
      await writeFile(db, "/x/y/f.txt", "data", {}, () => 2);
      link(db, "/x/y/f.txt", "/x/alias.txt");
      const inodes = db.all<{ inode: number }>("SELECT inode FROM vfs_nodes").map((r) => r.inode);
      const batched = pathsOfMany(db, inodes);
      for (const inode of inodes) {
        expect([...(batched.get(inode) ?? [])].sort()).toEqual([...pathsOf(db, inode)].sort());
      }
    });
  });

  it("issues a bounded number of SQL statements regardless of inode count", async () => {
    await withDB(async (db) => {
      mkdir(db, "/big", { recursive: true }, () => 1);
      for (let i = 0; i < 60; i++) {
        await writeFile(db, `/big/f${i}.txt`, "x", {}, () => 2);
      }
      const inodes = db.all<{ inode: number }>("SELECT inode FROM vfs_nodes").map((r) => r.inode);

      let statements = 0;
      const originalAll = db.all.bind(db);
      const originalOne = db.one.bind(db);
      (db as unknown as { all: unknown }).all = (...args: unknown[]) => {
        statements += 1;
        return (originalAll as (...a: unknown[]) => unknown)(...args);
      };
      (db as unknown as { one: unknown }).one = (...args: unknown[]) => {
        statements += 1;
        return (originalOne as (...a: unknown[]) => unknown)(...args);
      };
      try {
        pathsOfMany(db, inodes);
      } finally {
        (db as unknown as { all: unknown }).all = originalAll;
        (db as unknown as { one: unknown }).one = originalOne;
      }

      // The batched resolver must not scale its statement count with the
      // number of inodes. pathsOf would issue >= inodes.length here.
      expect(statements).toBeLessThan(5);
      expect(inodes.length).toBeGreaterThan(60);
    });
  });
});
