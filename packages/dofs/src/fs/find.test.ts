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

  it("applies limit and offset while walking in deterministic order", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a/b", { recursive: true }, () => 0);
      await writeFile(db, "/a/1.ts", "", {}, () => 0);
      await writeFile(db, "/a/b/2.ts", "", {}, () => 0);
      await writeFile(db, "/a/b/3.ts", "", {}, () => 0);
      await writeFile(db, "/a/z.ts", "", {}, () => 0);

      expect(find(db, "/a", "**/*.ts", { offset: 1, limit: 2 })).toEqual([
        { path: "/a/b/2.ts", type: "file" },
        { path: "/a/b/3.ts", type: "file" },
      ]);
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

  describe("exclude", () => {
    async function tree(db: Parameters<typeof find>[0]) {
      mkdir(db, "/node_modules/pkg/dist", { recursive: true }, () => 0);
      mkdir(db, "/src/nested", { recursive: true }, () => 0);
      await writeFile(db, "/node_modules/pkg/dist/index.js", "", {}, () => 0);
      await writeFile(db, "/node_modules/pkg/package.json", "", {}, () => 0);
      await writeFile(db, "/src/app.ts", "", {}, () => 0);
      await writeFile(db, "/src/nested/deep.ts", "", {}, () => 0);
    }

    it("omits an excluded directory and everything beneath it", async () => {
      await withDB(async (db) => {
        await tree(db);
        const paths = find(db, "/", undefined, { exclude: ["node_modules"] })
          .map((e) => e.path)
          .sort();
        expect(paths).toEqual(["/src", "/src/app.ts", "/src/nested", "/src/nested/deep.ts"]);
      });
    });

    it("matches an excluded segment at any depth", async () => {
      await withDB(async (db) => {
        mkdir(db, "/a/node_modules/deep", { recursive: true }, () => 0);
        await writeFile(db, "/a/node_modules/deep/x.js", "", {}, () => 0);
        await writeFile(db, "/a/keep.ts", "", {}, () => 0);
        const paths = find(db, "/", undefined, { exclude: ["node_modules"] })
          .map((e) => e.path)
          .sort();
        expect(paths).toEqual(["/a", "/a/keep.ts"]);
      });
    });

    it("excludes matching files as well as directories", async () => {
      await withDB(async (db) => {
        mkdir(db, "/d", {}, () => 0);
        await writeFile(db, "/d/keep.ts", "", {}, () => 0);
        await writeFile(db, "/d/skip.log", "", {}, () => 0);
        const paths = find(db, "/", undefined, { exclude: ["skip.log"] })
          .map((e) => e.path)
          .sort();
        expect(paths).toEqual(["/d", "/d/keep.ts"]);
      });
    });

    it("does not match a partial segment", async () => {
      await withDB(async (db) => {
        mkdir(db, "/node_modules_extra", {}, () => 0);
        await writeFile(db, "/node_modules_extra/a.ts", "", {}, () => 0);
        const paths = find(db, "/", undefined, { exclude: ["node_modules"] })
          .map((e) => e.path)
          .sort();
        expect(paths).toEqual(["/node_modules_extra", "/node_modules_extra/a.ts"]);
      });
    });

    it("accepts several exclude patterns", async () => {
      await withDB(async (db) => {
        await tree(db);
        mkdir(db, "/dist", {}, () => 0);
        await writeFile(db, "/dist/out.js", "", {}, () => 0);
        const paths = find(db, "/", undefined, { exclude: ["node_modules", "dist"] })
          .map((e) => e.path)
          .sort();
        expect(paths).toEqual(["/src", "/src/app.ts", "/src/nested", "/src/nested/deep.ts"]);
      });
    });

    it("combines with a pattern", async () => {
      await withDB(async (db) => {
        await tree(db);
        const paths = find(db, "/", "**/*.ts", { exclude: ["node_modules"] })
          .map((e) => e.path)
          .sort();
        expect(paths).toEqual(["/src/app.ts", "/src/nested/deep.ts"]);
      });
    });

    it("an empty exclude list behaves like no exclude", async () => {
      await withDB(async (db) => {
        await tree(db);
        const withEmpty = find(db, "/", undefined, { exclude: [] }).map((e) => e.path);
        const without = find(db, "/").map((e) => e.path);
        expect(withEmpty.sort()).toEqual(without.sort());
      });
    });

    it("never descends into an excluded directory", async () => {
      await withDB(async (db) => {
        mkdir(db, "/node_modules/a/b/c", { recursive: true }, () => 0);
        await writeFile(db, "/node_modules/a/b/c/deep.js", "", {}, () => 0);
        await writeFile(db, "/keep.ts", "", {}, () => 0);

        let statements = 0;
        const originalAll = db.all.bind(db);
        (db as unknown as { all: unknown }).all = (...args: unknown[]) => {
          statements += 1;
          return (originalAll as (...a: unknown[]) => unknown)(...args);
        };
        try {
          find(db, "/", undefined, { exclude: ["node_modules"] });
        } finally {
          (db as unknown as { all: unknown }).all = originalAll;
        }

        // Pruning must stop the walk at /node_modules itself: one readChildren
        // for the root, and nothing for the excluded subtree's four levels.
        expect(statements).toBeLessThanOrEqual(2);
      });
    });
  });
});
