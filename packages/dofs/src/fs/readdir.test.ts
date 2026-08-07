import { describe, expect, it, vi } from "vitest";

import { mkdir } from "./mkdir.js";
import { readdir } from "./readdir.js";
import { withDB } from "./with-db.js";
import {
  openWriteBufferForCreateSync,
  releaseWriteBufferSync,
  writeFile,
  writeRangeSync,
} from "./writeFile.js";

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
    const { symlink } = await import("./symlink.js");
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
