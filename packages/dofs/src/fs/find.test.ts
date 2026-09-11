import { describe, expect, it } from "vitest";

import { find } from "./find.js";
import { mkdir } from "./mkdir.js";
import { resolveInode } from "./resolve.js";
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

  describe("exclude", () => {
    it("leaves an excluded file out of the results", async () => {
      await withDB(async (db) => {
        mkdir(db, "/a", {}, () => 0);
        await writeFile(db, "/a/keep.ts", "", {}, () => 0);
        await writeFile(db, "/a/skip.ts", "", {}, () => 0);
        const paths = find(db, "/a", "**/*.ts", { exclude: ["skip.ts"] }).map((e) => e.path);
        expect(paths).toEqual(["/a/keep.ts"]);
      });
    });

    it("matches exclusions relative to the search root", async () => {
      await withDB(async (db) => {
        mkdir(db, "/root/pkg/node_modules", { recursive: true }, () => 0);
        await writeFile(db, "/root/pkg/index.ts", "", {}, () => 0);
        await writeFile(db, "/root/pkg/node_modules/dep.ts", "", {}, () => 0);
        // The pattern names the path below /root, not the absolute one.
        const paths = find(db, "/root", "**/*.ts", { exclude: ["pkg/node_modules/**"] }).map(
          (e) => e.path,
        );
        expect(paths).toEqual(["/root/pkg/index.ts"]);
      });
    });

    it("accepts several patterns", async () => {
      await withDB(async (db) => {
        mkdir(db, "/a/node_modules", { recursive: true }, () => 0);
        mkdir(db, "/a/.git", { recursive: true }, () => 0);
        await writeFile(db, "/a/index.ts", "", {}, () => 0);
        await writeFile(db, "/a/node_modules/dep.ts", "", {}, () => 0);
        await writeFile(db, "/a/.git/hook.ts", "", {}, () => 0);
        const paths = find(db, "/a", "**/*.ts", {
          exclude: ["node_modules", "node_modules/**", ".git", ".git/**"],
        }).map((e) => e.path);
        expect(paths).toEqual(["/a/index.ts"]);
      });
    });

    it("takes precedence over the inclusion glob", async () => {
      await withDB(async (db) => {
        mkdir(db, "/a", {}, () => 0);
        await writeFile(db, "/a/x.ts", "", {}, () => 0);
        expect(find(db, "/a", "**/*.ts", { exclude: ["**/*.ts"] })).toEqual([]);
      });
    });

    it("drops an excluded directory as well as its contents", async () => {
      await withDB(async (db) => {
        mkdir(db, "/a/build/nested", { recursive: true }, () => 0);
        await writeFile(db, "/a/keep.txt", "", {}, () => 0);
        await writeFile(db, "/a/build/out.txt", "", {}, () => 0);
        await writeFile(db, "/a/build/nested/deep.txt", "", {}, () => 0);
        const paths = find(db, "/a", undefined, { exclude: ["build"] })
          .map((e) => e.path)
          .sort();
        expect(paths).toEqual(["/a/keep.txt"]);
      });
    });

    it("prunes the excluded subtree instead of filtering it afterwards", async () => {
      await withDB(async (db) => {
        mkdir(db, "/a/build/nested", { recursive: true }, () => 0);
        await writeFile(db, "/a/keep.txt", "", {}, () => 0);
        await writeFile(db, "/a/build/nested/deep.txt", "", {}, () => 0);

        const buildInode = resolveInode(db, "/a/build")?.inode;
        const nestedInode = resolveInode(db, "/a/build/nested")?.inode;
        expect(buildInode).toBeDefined();
        expect(nestedInode).toBeDefined();

        // Record the parent inode of every child listing the walk asks
        // for. A pruned directory is never listed.
        const listedParents: unknown[] = [];
        const all = db.all.bind(db);
        // biome-ignore lint/suspicious/noExplicitAny: test spy over the generic method
        (db as any).all = (query: string, ...bindings: unknown[]) => {
          if (query.includes("FROM vfs_dirents d")) listedParents.push(bindings[0]);
          return all(query, ...bindings);
        };
        try {
          find(db, "/a", undefined, { exclude: ["build"] });
        } finally {
          // biome-ignore lint/suspicious/noExplicitAny: restore the spied method
          (db as any).all = all;
        }

        expect(listedParents).not.toContain(buildInode);
        expect(listedParents).not.toContain(nestedInode);
      });
    });

    it("applies limit and offset to the surviving matches", async () => {
      await withDB(async (db) => {
        mkdir(db, "/a/skip", { recursive: true }, () => 0);
        await writeFile(db, "/a/1.ts", "", {}, () => 0);
        await writeFile(db, "/a/2.ts", "", {}, () => 0);
        await writeFile(db, "/a/3.ts", "", {}, () => 0);
        await writeFile(db, "/a/skip/x.ts", "", {}, () => 0);
        expect(
          find(db, "/a", "**/*.ts", { exclude: ["skip", "skip/**"], offset: 1, limit: 1 }),
        ).toEqual([{ path: "/a/2.ts", type: "file" }]);
      });
    });

    it("ignores an empty exclusion list and empty patterns", async () => {
      await withDB(async (db) => {
        mkdir(db, "/a", {}, () => 0);
        await writeFile(db, "/a/x.ts", "", {}, () => 0);
        expect(find(db, "/a", "**/*.ts", { exclude: [] }).map((e) => e.path)).toEqual(["/a/x.ts"]);
        expect(find(db, "/a", "**/*.ts", { exclude: [""] }).map((e) => e.path)).toEqual([
          "/a/x.ts",
        ]);
      });
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
