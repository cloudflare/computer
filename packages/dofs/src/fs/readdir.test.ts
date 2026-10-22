import { describe, expect, it, vi } from "vitest";

import { mkdir } from "./mkdir";
import { readdir, readdirStats } from "./readdir";
import { withDB } from "./with-db";
import {
  openWriteBufferForCreateSync,
  releaseWriteBufferSync,
  writeFile,
  writeRangeSync,
} from "./writeFile";

describe("readdir", () => {
  it("returns an empty array for an empty directory", async () => {
    await withDB((db) => {
      expect(readdir(db, "/")).toEqual([]);
    });
  });

  it("lists files and directories with dirent shape", async () => {
    await withDB(async (db) => {
      mkdir(db, "/sub", {}, () => 0);
      await writeFile(db, "/file.txt", "x", {}, () => 0);

      const entries = readdir(db, "/");
      expect(entries).toHaveLength(2);
      expect(entries).toContainEqual({
        name: "file.txt",
        parentPath: "/",
        size: 1,
        mtime: 0,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      });
      expect(entries).toContainEqual({
        name: "sub",
        parentPath: "/",
        size: 0,
        mtime: 0,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      });
    });
  });

  it("sorts entries by name", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/b", "", {}, () => 0);
      await writeFile(db, "/a", "", {}, () => 0);
      await writeFile(db, "/c", "", {}, () => 0);
      expect(readdir(db, "/").map((e) => e.name)).toEqual(["a", "b", "c"]);
    });
  });

  it("paginates committed entries by stable name order", async () => {
    await withDB(async (db) => {
      for (const name of ["a", "b", "c", "d"]) {
        await writeFile(db, `/${name}`, name, {}, () => 0);
      }
      expect(readdir(db, "/", { limit: 2, offset: 0 }).map((entry) => entry.name)).toEqual([
        "a",
        "b",
      ]);
      expect(readdir(db, "/", { limit: 2, offset: 2 }).map((entry) => entry.name)).toEqual([
        "c",
        "d",
      ]);
    });
  });

  it("merges pending files before applying pagination", async () => {
    await withDB(async (db) => {
      for (const name of ["a", "c", "e"]) {
        await writeFile(db, `/${name}`, name, {}, () => 0);
      }
      openWriteBufferForCreateSync(db, "/b", {}, () => 10);
      writeRangeSync(db, "/b", new TextEncoder().encode("pending"), 0, {}, () => 11);

      expect(readdir(db, "/", { limit: 2, offset: 0 }).map((entry) => entry.name)).toEqual([
        "a",
        "b",
      ]);
      expect(readdir(db, "/", { limit: 2, offset: 2 }).map((entry) => entry.name)).toEqual([
        "c",
        "e",
      ]);
      expect(readdir(db, "/", { limit: 2, offset: 0 })[1]).toMatchObject({
        name: "b",
        size: 7,
        mtime: 10,
      });

      releaseWriteBufferSync(db, "/b", () => 12);
    });
  });

  it("ignores a pending file whose committed entry is outside the requested page", async () => {
    await withDB(async (db) => {
      for (const name of ["b", "c", "d", "e", "f", "g", "h"]) {
        await writeFile(db, `/${name}`, name, {}, () => 0);
      }
      openWriteBufferForCreateSync(db, "/a", {}, () => 10);
      await writeFile(db, "/landed", "committed", {}, () => 11);
      db.run("UPDATE vfs_dirents SET name = ? WHERE name = ?", "a", "landed");

      expect(readdir(db, "/", { limit: 2, offset: 5 }).map((entry) => entry.name)).toEqual([
        "f",
        "g",
      ]);
    });
  });

  it("bounds committed rows fetched for a deep page with a pending file", async () => {
    await withDB(async (db) => {
      for (let index = 0; index < 30; index += 1) {
        const name = `file-${index.toString().padStart(2, "0")}`;
        await writeFile(db, `/${name}`, name, {}, () => 0);
      }
      openWriteBufferForCreateSync(db, "/pending", {}, () => 10);

      const all = vi.spyOn(db, "all");
      expect(readdir(db, "/", { limit: 2, offset: 25 }).map((entry) => entry.name)).toEqual([
        "file-25",
        "file-26",
      ]);
      const pageQuery = all.mock.calls.find(([query]) =>
        String(query).includes("FROM vfs_dirents d"),
      );
      expect(pageQuery?.slice(-2)).toEqual([4, 24]);
    });
  });

  it("keeps UTF-8 filename pages stable when a pending file commits", async () => {
    await withDB(async (db) => {
      const bmpName = "\uE000";
      const astralName = "\u{10000}";
      await writeFile(db, `/${bmpName}`, "committed", {}, () => 0);
      openWriteBufferForCreateSync(db, `/${astralName}`, {}, () => 1);

      expect(readdir(db, "/", { limit: 1, offset: 0 }).map((entry) => entry.name)).toEqual([
        bmpName,
      ]);
      expect(readdir(db, "/", { limit: 1, offset: 1 }).map((entry) => entry.name)).toEqual([
        astralName,
      ]);

      releaseWriteBufferSync(db, `/${astralName}`, () => 2);
      expect(readdir(db, "/", { limit: 1, offset: 0 }).map((entry) => entry.name)).toEqual([
        bmpName,
      ]);
      expect(readdir(db, "/", { limit: 1, offset: 1 }).map((entry) => entry.name)).toEqual([
        astralName,
      ]);
    });
  });

  it("rejects invalid offsets", async () => {
    await withDB((db) => {
      expect(() => readdir(db, "/", { offset: -1 })).toThrowError(
        "readdir offset must be a non-negative safe integer",
      );
    });
  });

  it("uses the canonical parent path for nested directories", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a/b", { recursive: true }, () => 0);
      await writeFile(db, "/a/b/leaf.txt", "x", {}, () => 0);

      const entries = readdir(db, "/a/b");
      expect(entries).toEqual([
        {
          name: "leaf.txt",
          parentPath: "/a/b",
          size: 1,
          mtime: 0,
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
        },
      ]);
    });
  });

  it("canonicalizes the parentPath even when called with a non-canonical input", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a", {}, () => 0);
      await writeFile(db, "/a/x", "", {}, () => 0);
      const entries = readdir(db, "/a//.");
      expect(entries[0]).toMatchObject({ parentPath: "/a" });
    });
  });

  it("throws ENOENT for a missing path", async () => {
    await withDB((db) => {
      expect(() => readdir(db, "/missing")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("throws ENOENT when an intermediate segment is missing", async () => {
    await withDB((db) => {
      expect(() => readdir(db, "/no/such/path")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("includes symlink entries with isSymbolicLink set", async () => {
    // resolveInode + readdir originally only filtered file and dir
    // rows; symlinks were invisible. The dirent shape now carries
    // an explicit isSymbolicLink flag so just-bash and other
    // adapters can branch on the type without a follow-up lstat.
    const { symlink } = await import("./symlink");
    await withDB(async (db) => {
      await writeFile(db, "/target", "x", {}, () => 0);
      symlink(db, "/target", "/link", () => 0);
      const entries = readdir(db, "/");
      const link = entries.find((e) => e.name === "link");
      expect(link).toMatchObject({
        name: "link",
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
      });
    });
  });

  it("throws ENOTDIR when called on a file", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/file.txt", "x", {}, () => 0);
      expect(() => readdir(db, "/file.txt")).toThrowError(
        expect.objectContaining({ code: "ENOTDIR" }),
      );
    });
  });
});

describe("readdirStats", () => {
  it("returns what a stat of each entry would, in name order", async () => {
    const { chmod } = await import("./chmod");
    const { link } = await import("./link");
    const { lstat } = await import("./stat");
    const { symlink } = await import("./symlink");
    await withDB(async (db) => {
      mkdir(db, "/sub", { mode: 0o700 }, () => 5);
      await writeFile(db, "/file.txt", "hello", {}, () => 7);
      chmod(db, "/file.txt", 0o640, () => 7);
      link(db, "/file.txt", "/hard.txt");
      symlink(db, "file.txt", "/link", () => 9);

      const entries = readdirStats(db, "/");
      expect(entries.map((entry) => entry.name)).toEqual(["file.txt", "hard.txt", "link", "sub"]);
      for (const entry of entries) {
        const stat = lstat(db, `/${entry.name}`);
        expect(entry).toMatchObject({
          inode: stat.inode,
          mode: stat.mode,
          mtime: stat.mtime,
          size: stat.size,
        });
      }
      expect(entries[0]).toMatchObject({ type: "file", mode: 0o640, size: 5, nlink: 2 });
      expect(entries[1].inode).toBe(entries[0].inode);
      expect(entries[2]).toMatchObject({ type: "symlink", linkTarget: "file.txt", nlink: 1 });
      expect(entries[3]).toMatchObject({ type: "dir", mode: 0o700, size: 0, nlink: 1 });
    });
  });

  it("includes pending files and the size of open write buffers", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a", "old", {}, () => 0);
      openWriteBufferForCreateSync(db, "/b", { mode: 0o600 }, () => 10);
      writeRangeSync(db, "/b", new TextEncoder().encode("pending"), 0, {}, () => 11);

      expect(readdirStats(db, "/")).toEqual([
        expect.objectContaining({ name: "a", type: "file", size: 3 }),
        { name: "b", inode: 0, type: "file", mode: 0o600, size: 7, mtime: 10, nlink: 1 },
      ]);
      releaseWriteBufferSync(db, "/b", () => 12);
      expect(readdirStats(db, "/")[1]).toMatchObject({ name: "b", mode: 0o600, size: 7 });
      expect(readdirStats(db, "/")[1].inode).toBeGreaterThan(0);
    });
  });

  it("reports a pending file over a committed one of the same name, as lstat does", async () => {
    const { lstat } = await import("./stat");
    await withDB(async (db) => {
      openWriteBufferForCreateSync(db, "/f", { mode: 0o600 }, () => 1);
      await writeFile(db, "/f", "abc", {}, () => 2);

      const entries = readdirStats(db, "/");
      expect(entries).toHaveLength(1);
      const stat = lstat(db, "/f");
      expect(entries[0]).toMatchObject({
        inode: stat.inode,
        mode: stat.mode,
        mtime: stat.mtime,
        size: stat.size,
      });
    });
  });

  it("lists a directory in one statement", async () => {
    await withDB(async (db) => {
      mkdir(db, "/d", {}, () => 0);
      for (const name of ["x", "y", "z"]) await writeFile(db, `/d/${name}`, name, {}, () => 0);
      const exec = vi.spyOn(db.sql, "exec");
      expect(readdirStats(db, "/d")).toHaveLength(3);
      // Resolving /d (outside a transaction, one statement), then the listing.
      expect(exec).toHaveBeenCalledTimes(2);
    });
  });

  it("throws ENOTDIR when called on a file", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/file.txt", "x", {}, () => 0);
      expect(() => readdirStats(db, "/file.txt")).toThrowError(
        expect.objectContaining({ code: "ENOTDIR" }),
      );
    });
  });
});
