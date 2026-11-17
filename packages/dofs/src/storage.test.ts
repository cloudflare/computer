import { describe, expect, it } from "vitest";

import { readFile } from "./fs/readFile";
import { rm } from "./fs/rm";
import { withDB } from "./fs/with-db";
import { writeFileSync } from "./fs/writeFile";
import type { Database } from "./storage";

// Nested transactionSync on a Database. These run on both backends:
// node:sqlite through NodeSQLiteStorage, and a Durable Object's own
// storage under the workers config.

function createProbe(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS probe (v INTEGER)");
}

function probe(db: Database): number[] {
  return db.all<{ v: number }>("SELECT v FROM probe ORDER BY v").map((row) => row.v);
}

function insert(db: Database, v: number): void {
  db.run("INSERT INTO probe (v) VALUES (?)", v);
}

describe("nested transactionSync", () => {
  it("commits nested work with the outer transaction and returns the inner value", async () => {
    await withDB((db) => {
      createProbe(db);
      const result = db.transactionSync(() => {
        insert(db, 1);
        return db.transactionSync(() => {
          insert(db, 2);
          return "inner";
        });
      });
      expect(result).toBe("inner");
      expect(probe(db)).toEqual([1, 2]);
      expect(db.inTransaction).toBe(false);
    });
  });

  it("rolls back only the inner work when an inner transaction throws", async () => {
    await withDB((db) => {
      createProbe(db);
      db.transactionSync(() => {
        insert(db, 1);
        expect(() =>
          db.transactionSync(() => {
            insert(db, 2);
            throw new Error("inner");
          }),
        ).toThrow("inner");
        expect(db.inTransaction).toBe(true);
        insert(db, 3);
      });
      expect(probe(db)).toEqual([1, 3]);
    });
  });

  it("rolls back everything, inner work included, when the outer transaction throws", async () => {
    await withDB((db) => {
      createProbe(db);
      expect(() =>
        db.transactionSync(() => {
          insert(db, 1);
          db.transactionSync(() => {
            insert(db, 2);
          });
          throw new Error("outer");
        }),
      ).toThrow("outer");
      expect(probe(db)).toEqual([]);
      expect(db.inTransaction).toBe(false);
    });
  });

  it("nests three levels deep", async () => {
    await withDB((db) => {
      createProbe(db);
      db.transactionSync(() => {
        insert(db, 1);
        db.transactionSync(() => {
          insert(db, 2);
          expect(() =>
            db.transactionSync(() => {
              insert(db, 3);
              throw new Error("deepest");
            }),
          ).toThrow("deepest");
          db.transactionSync(() => {
            insert(db, 4);
          });
        });
      });
      expect(probe(db)).toEqual([1, 2, 4]);
    });
  });

  it("commits filesystem writes made inside an outer transaction together", async () => {
    await withDB(async (db) => {
      writeFileSync(db, "/old.txt", new TextEncoder().encode("old"), {}, () => 1);
      db.transactionSync(() => {
        rm(db, "/old.txt", {});
        writeFileSync(db, "/new.txt", new TextEncoder().encode("new"), {}, () => 2);
      });
      expect(await readFile(db, "/new.txt", "utf8")).toBe("new");
      await expect(readFile(db, "/old.txt", "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rolls filesystem writes back with an outer transaction that throws", async () => {
    await withDB(async (db) => {
      writeFileSync(db, "/kept.txt", new TextEncoder().encode("kept"), {}, () => 1);
      expect(() =>
        db.transactionSync(() => {
          rm(db, "/kept.txt", {});
          writeFileSync(db, "/doomed.txt", new TextEncoder().encode("doomed"), {}, () => 2);
          throw new Error("outer");
        }),
      ).toThrow("outer");
      expect(await readFile(db, "/kept.txt", "utf8")).toBe("kept");
      await expect(readFile(db, "/doomed.txt", "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
