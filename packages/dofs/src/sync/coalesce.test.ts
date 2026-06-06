import { describe, expect, it } from "vitest";

import { link } from "../fs/link.js";
import { mkdir } from "../fs/mkdir.js";
import { rename } from "../fs/rename.js";
import { rm } from "../fs/rm.js";
import { symlink } from "../fs/symlink.js";
import { withDB } from "../fs/with-db.js";
import { writeFile, writeFileSync } from "../fs/writeFile.js";
import { coalesceChanges } from "./coalesce.js";
import { currentRev } from "./watermarks.js";

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

  it("yields one entry per touched path after the cursor", async () => {
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

  it("cursor rev filters out changes the receiver has already seen", async () => {
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

  it("resumes after a path within the same rev", async () => {
    await withDB(async (db) => {
      mkdir(db, "/src", {}, () => 1);
      await writeFile(db, "/src/a.txt", "a", {}, () => 2);
      await writeFile(db, "/src/b.txt", "b", {}, () => 3);
      const beforeRename = currentRev(db);

      rename(db, "/src", "/dst");
      const renameRev = currentRev(db);
      expect(renameRev).toBeGreaterThan(beforeRename);

      const allSameRev = await drain(coalesceChanges(db, { rev: beforeRename, path: null }));
      const paths = allSameRev.map((entry) => entry.path);
      expect(paths).toEqual([...paths].sort());
      expect(new Set(allSameRev.map((entry) => entry.rev))).toEqual(new Set([renameRev]));

      const resumed = await drain(coalesceChanges(db, { rev: renameRev, path: "/dst/a.txt" }));
      expect(resumed.map((entry) => entry.path)).toEqual(
        paths.filter((path) => path > "/dst/a.txt"),
      );
    });
  });

  it("skips a whole rev when the cursor path is null", async () => {
    await withDB(async (db) => {
      mkdir(db, "/src", {}, () => 1);
      await writeFile(db, "/src/a.txt", "a", {}, () => 2);
      const beforeRename = currentRev(db);

      rename(db, "/src", "/dst");
      const renameRev = currentRev(db);
      expect(await drain(coalesceChanges(db, { rev: beforeRename, path: null }))).not.toEqual([]);
      expect(await drain(coalesceChanges(db, { rev: renameRev, path: null }))).toEqual([]);
    });
  });

  it("orders entries deterministically by rev then path", async () => {
    await withDB(async (db) => {
      mkdir(db, "/src", {}, () => 1);
      await writeFile(db, "/src/b.txt", "b", {}, () => 2);
      await writeFile(db, "/src/a.txt", "a", {}, () => 3);
      rename(db, "/src", "/dst");

      const entries = await drain(coalesceChanges(db, { rev: 0, path: null }));
      const pairs = entries.map((entry) => [entry.rev, entry.path] as const);
      expect(pairs).toEqual(
        [...pairs].sort((a, b) => {
          if (a[0] !== b[0]) return a[0] - b[0];
          return a[1].localeCompare(b[1]);
        }),
      );
    });
  });

  it("excludes entries newer than the through rev", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/included.txt", "included", {}, () => 1);
      const throughRev = currentRev(db);
      await writeFile(db, "/excluded.txt", "excluded", {}, () => 2);

      const entries = await drain(
        coalesceChanges(db, { rev: 0, path: null }, { through: { rev: throughRev, path: null } }),
      );

      expect(entries.map((entry) => entry.path)).toContain("/included.txt");
      expect(entries.map((entry) => entry.path)).not.toContain("/excluded.txt");
    });
  });

  it("excludes same-rev entries after the through path", async () => {
    await withDB(async (db) => {
      mkdir(db, "/src", {}, () => 1);
      await writeFile(db, "/src/a.txt", "a", {}, () => 2);
      await writeFile(db, "/src/b.txt", "b", {}, () => 3);
      const beforeRename = currentRev(db);

      rename(db, "/src", "/dst");
      const renameRev = currentRev(db);

      const entries = await drain(
        coalesceChanges(
          db,
          { rev: beforeRename, path: null },
          {
            through: { rev: renameRev, path: "/dst/a.txt" },
          },
        ),
      );

      expect(entries.map((entry) => entry.path)).toEqual(["/dst", "/dst/a.txt"]);
    });
  });

  it("skips an entry that materializes beyond the through cursor", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/file.txt", "first", {}, () => 1);
      const throughRev = currentRev(db);

      const originalOne = db.one.bind(db);
      let rewrote = false;
      db.one = ((query: string, ...bindings: unknown[]) => {
        if (!rewrote && query === "SELECT rev FROM vfs_nodes WHERE inode = ?") {
          rewrote = true;
          writeFileSync(db, "/file.txt", new TextEncoder().encode("second"), {}, () => 2);
        }
        return originalOne(query, ...bindings);
      }) as typeof db.one;

      const entries = await drain(
        coalesceChanges(db, { rev: 0, path: null }, { through: { rev: throughRev, path: null } }),
      );

      expect(rewrote).toBe(true);
      expect(entries).toEqual([]);
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

  it("emits an entry for every hardlink name of a touched inode", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a", "shared", {}, () => 1);
      link(db, "/a", "/b");

      const entries = await drain(coalesceChanges(db, 0));
      const files = entries.filter((e) => e.kind === "file").map((e) => e.path);
      // Both names share one inode; pathOf would pick only one of them.
      // The wire has to carry both so the receiver materialises each.
      expect(files).toContain("/a");
      expect(files).toContain("/b");
    });
  });

  it("defers a path whose live state raced past the snapshot, then redelivers it", async () => {
    // Pins the documented cursor contract (docs/02_sync_protocol.md):
    // `through` is a resume bound, not a point-in-time snapshot. A path
    // deleted at the snapshot rev but recreated above it is dropped from
    // the bounded scan, because materialiseChange reads the live state
    // and inCursorWindow filters it out. The omission is not loss — the
    // recreate's rev is above the snapshot, so the next scan redelivers
    // the path. Convergence holds without the store keeping history.
    await withDB(async (db) => {
      await writeFile(db, "/x", "v1", {}, () => 1);
      rm(db, "/x", {});
      const snapshot = currentRev(db);
      await writeFile(db, "/x", "v2", {}, () => 2);

      // Bounded by the snapshot: the rev-`snapshot` delete is a
      // candidate, but the live entry now sits above the window, so /x
      // is omitted from this snapshot rather than frozen at the delete.
      const bounded = await drain(
        coalesceChanges(db, 0, { through: { rev: snapshot, path: null } }),
      );
      expect(bounded.some((e) => e.path === "/x")).toBe(false);

      // The next scan resumes after the snapshot rev and redelivers /x
      // at its current state. The rev that caused the drop is above the
      // snapshot, so a later window always covers it.
      const next = await drain(coalesceChanges(db, snapshot));
      expect(next.find((e) => e.path === "/x")).toMatchObject({ kind: "file", path: "/x" });
    });
  });

  it("emits the new name when a hardlinked file is renamed", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a", "shared", {}, () => 1);
      link(db, "/a", "/b");
      // /a and /b now share an inode. Renaming /a to /c leaves the
      // inode named /b and /c; pathOf might resolve it to /b and never
      // emit /c, dropping the renamed name on the wire.
      const baseline = currentRev(db);
      rename(db, "/a", "/c");

      const entries = await drain(coalesceChanges(db, baseline));
      const live = entries.filter((e) => e.kind !== "delete").map((e) => e.path);
      const deletes = entries.filter((e) => e.kind === "delete").map((e) => e.path);
      expect(live).toContain("/c");
      expect(live).toContain("/b");
      expect(deletes).toContain("/a");
    });
  });
});
