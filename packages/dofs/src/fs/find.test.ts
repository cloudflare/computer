import { describe, expect, it } from "vitest";

import { find } from "./find.js";
import { mkdir } from "./mkdir.js";
import { withDB } from "./with-db.js";
import { writeFile } from "./writeFile.js";

describe("find", () => {
  it("returns nothing for an empty directory", async () => {
    await withDB((db) => {
      expect(find(db, "/")).toEqual([]);
    });
  });

  it("walks every entry without a pattern", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a/b", { recursive: true }, () => 0);
      await writeFile(db, "/a/x.ts", "", {}, () => 0);
      await writeFile(db, "/a/b/y.md", "", {}, () => 0);
      const entries = find(db, "/").sort((p, q) => p.path.localeCompare(q.path));
      expect(entries).toEqual([
        { path: "/a", type: "dir" },
        { path: "/a/b", type: "dir" },
        { path: "/a/b/y.md", type: "file" },
        { path: "/a/x.ts", type: "file" },
      ]);
    });
  });

  it("treats an empty pattern like no pattern and returns every entry", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a/b", { recursive: true }, () => 0);
      await writeFile(db, "/a/x.ts", "", {}, () => 0);
      await writeFile(db, "/a/b/y.md", "", {}, () => 0);
      const entries = find(db, "/", "").sort((p, q) => p.path.localeCompare(q.path));
      expect(entries).toEqual([
        { path: "/a", type: "dir" },
        { path: "/a/b", type: "dir" },
        { path: "/a/b/y.md", type: "file" },
        { path: "/a/x.ts", type: "file" },
      ]);
    });
  });

  it("matches a single-level glob *.ts within the directory only", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a/b", { recursive: true }, () => 0);
      await writeFile(db, "/a/x.ts", "", {}, () => 0);
      await writeFile(db, "/a/b/y.ts", "", {}, () => 0);
      const paths = find(db, "/a", "*.ts")
        .map((e) => e.path)
        .sort();
      expect(paths).toEqual(["/a/x.ts"]);
    });
  });

  it("matches ? as one non-separator character", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a", {}, () => 0);
      await writeFile(db, "/a/a.ts", "", {}, () => 0);
      await writeFile(db, "/a/ab.ts", "", {}, () => 0);
      await writeFile(db, "/a/b.ts", "", {}, () => 0);
      const paths = find(db, "/a", "?.ts").map((entry) => entry.path);
      expect(paths).toEqual(["/a/a.ts", "/a/b.ts"]);
    });
  });

  it("matches ** recursively", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a/b/c", { recursive: true }, () => 0);
      await writeFile(db, "/a/x.md", "", {}, () => 0);
      await writeFile(db, "/a/b/y.md", "", {}, () => 0);
      await writeFile(db, "/a/b/c/z.md", "", {}, () => 0);
      const paths = find(db, "/a", "**/*.md")
        .map((e) => e.path)
        .sort();
      expect(paths).toEqual(["/a/b/c/z.md", "/a/b/y.md", "/a/x.md"]);
    });
  });

  it("walks from a nested directory", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a/b/c", { recursive: true }, () => 0);
      await writeFile(db, "/a/b/y.ts", "", {}, () => 0);
      await writeFile(db, "/a/b/c/z.ts", "", {}, () => 0);
      const paths = find(db, "/a/b", "**/*.ts")
        .map((e) => e.path)
        .sort();
      expect(paths).toEqual(["/a/b/c/z.ts", "/a/b/y.ts"]);
    });
  });

  it("does not match files outside the start directory even with **", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a", {}, () => 0);
      mkdir(db, "/b", {}, () => 0);
      await writeFile(db, "/a/x.ts", "", {}, () => 0);
      await writeFile(db, "/b/x.ts", "", {}, () => 0);
      const paths = find(db, "/a", "**/*.ts").map((e) => e.path);
      expect(paths).toEqual(["/a/x.ts"]);
    });
  });

  it("throws ENOENT when the directory is missing", async () => {
    await withDB((db) => {
      expect(() => find(db, "/missing")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
    });
  });

  it("throws ENOTDIR when called on a file", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/file.txt", "x", {}, () => 0);
      expect(() => find(db, "/file.txt")).toThrowError(
        expect.objectContaining({ code: "ENOTDIR" }),
      );
    });
  });

  it("escapes regex metacharacters in literal segments of a pattern", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a", {}, () => 0);
      await writeFile(db, "/a/file.ts", "", {}, () => 0);
      // The dot in `*.ts` is a regex metacharacter; make sure we don't match
      // any other single character against it.
      await writeFile(db, "/a/fileXts", "", {}, () => 0);
      const paths = find(db, "/a", "*.ts").map((e) => e.path);
      expect(paths).toEqual(["/a/file.ts"]);
    });
  });
});
