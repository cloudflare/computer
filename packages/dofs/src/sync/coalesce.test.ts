import { describe, expect, it } from "vitest";

import { mkdir } from "../fs/mkdir.js";
import { rm } from "../fs/rm.js";
import { symlink } from "../fs/symlink.js";
import { withDB } from "../fs/with-db.js";
import { writeFile } from "../fs/writeFile.js";
import { coalesceChanges } from "./coalesce.js";

// Drain an async iterable into an array. Tests stay synchronous-looking
// while the production code can stream.
async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("coalesceChanges", () => {
  it("yields nothing for an empty rev window", async () => {
    await withDB(async (db) => {
      const entries = await drain(coalesceChanges(db, 1_000_000));
      expect(entries).toEqual([]);
    });
  });

  it("yields one entry per touched path since sinceRev", async () => {
    await withDB(async (db) => {
      mkdir(db, "/d", { mode: 0o755 }, () => 1);
      await writeFile(db, "/d/a.txt", "alpha", {}, () => 2);
      const entries = await drain(coalesceChanges(db, 0));
      // root mkdir is implicit (already exists); we should see /d and /d/a.txt.
      const paths = entries.map((e) => e.path).sort();
      expect(paths).toContain("/d");
      expect(paths).toContain("/d/a.txt");
    });
  });

  it("coalesces five rewrites of the same path into one entry", async () => {
    await withDB(async (db) => {
      for (let i = 0; i < 5; i++) {
        await writeFile(db, "/log.txt", `pass ${i}`, {}, () => 100 + i);
      }
      const entries = await drain(coalesceChanges(db, 0));
      const log = entries.filter((e) => e.path === "/log.txt");
      expect(log).toHaveLength(1);
      // Latest state wins: the entry carries the size of "pass 4" (6 bytes).
      expect(log[0]).toMatchObject({ kind: "file", size: 6 });
    });
  });

  it("emits delete entries for tombstoned paths", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/gone.txt", "x", {}, () => 1);
      rm(db, "/gone.txt", {});
      const entries = await drain(coalesceChanges(db, 0));
      const gone = entries.find((e) => e.path === "/gone.txt");
      expect(gone).toEqual({ kind: "delete", rev: expect.any(Number), path: "/gone.txt" });
    });
  });

  it("emits resolved delete paths for removes through intermediate symlinks", async () => {
    await withDB(async (db) => {
      mkdir(db, "/real", {}, () => 1);
      await writeFile(db, "/real/file.txt", "x", {}, () => 2);
      symlink(db, "/real", "/link", () => 3);

      rm(db, "/link/file.txt", {});

      const entries = await drain(coalesceChanges(db, 0));
      expect(entries).toContainEqual({
        kind: "delete",
        rev: expect.any(Number),
        path: "/real/file.txt",
      });
      expect(entries).not.toContainEqual({
        kind: "delete",
        rev: expect.any(Number),
        path: "/link/file.txt",
      });
    });
  });

  it("delete-then-recreate yields a single live entry, not a delete", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/x.txt", "first", {}, () => 1);
      rm(db, "/x.txt", {});
      await writeFile(db, "/x.txt", "second", {}, () => 2);
      const entries = await drain(coalesceChanges(db, 0));
      const x = entries.filter((e) => e.path === "/x.txt");
      expect(x).toHaveLength(1);
      expect(x[0].kind).toBe("file");
    });
  });

  it("sinceRev filters out changes the receiver has already seen", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/old.txt", "old", {}, () => 1);
      // Read current rev counter to use as the cursor.
      const cursor = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;
      await writeFile(db, "/new.txt", "new", {}, () => 2);
      const entries = await drain(coalesceChanges(db, cursor));
      const paths = entries.map((e) => e.path);
      expect(paths).toContain("/new.txt");
      expect(paths).not.toContain("/old.txt");
    });
  });

  it("yields entries in ascending rev order", async () => {
    // pullOnce uses entry.rev as a per-batch checkpoint cursor. The
    // contract is monotonicity: if entry N has rev R, every entry
    // already emitted has rev <= R. Without that, the puller can't
    // advance fetchRev mid-stream without risking a skip on the next
    // resume.
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "a", {}, () => 1);
      mkdir(db, "/d", {}, () => 1);
      await writeFile(db, "/d/b.txt", "b", {}, () => 1);
      await writeFile(db, "/c.txt", "c", {}, () => 1);
      rm(db, "/a.txt", {});
      await writeFile(db, "/d/b.txt", "b2", {}, () => 2);
      const entries = await drain(coalesceChanges(db, 0));
      const revs = entries.map((e) => e.rev);
      for (let i = 1; i < revs.length; i++) {
        expect(revs[i]).toBeGreaterThanOrEqual(revs[i - 1]);
      }
    });
  });
});

describe("coalesceChanges (ignore)", () => {
  it("drops entries whose path contains an ignored segment", async () => {
    await withDB(async (db) => {
      mkdir(db, "/src", {}, () => 0);
      mkdir(db, "/node_modules", {}, () => 0);
      mkdir(db, "/node_modules/lodash", {}, () => 0);
      mkdir(db, "/a", {}, () => 0);
      mkdir(db, "/a/node_modules", {}, () => 0);
      mkdir(db, "/a/node_modules/p", {}, () => 0);
      await writeFile(db, "/src/index.ts", "x", {}, () => 1);
      await writeFile(db, "/node_modules/lodash/index.js", "y", {}, () => 2);
      await writeFile(db, "/a/node_modules/p/q.js", "z", {}, () => 3);
      const entries = await drain(coalesceChanges(db, 0, { ignore: ["node_modules"] }));
      const paths = entries.map((e) => e.path);
      expect(paths).toContain("/src/index.ts");
      for (const p of paths) {
        expect(p.includes("node_modules")).toBe(false);
      }
    });
  });

  it("an empty ignore list is the default behaviour", async () => {
    await withDB(async (db) => {
      mkdir(db, "/node_modules", {}, () => 0);
      await writeFile(db, "/node_modules/x.js", "x", {}, () => 1);
      const entries = await drain(coalesceChanges(db, 0));
      expect(entries.some((e) => e.path === "/node_modules/x.js")).toBe(true);
    });
  });
});
