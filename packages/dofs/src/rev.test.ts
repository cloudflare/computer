import { describe, expect, it } from "vitest";

import { withDB } from "./fs/with-db";
import { incrementRev } from "./rev";

describe("incrementRev", () => {
  it("returns the new rev value and persists it to vfs_meta", async () => {
    await withDB(
      (db) => {
        // initializeSchema seeds rev = 1.
        const next = incrementRev(db);
        expect(next).toBe(2);

        const stored = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = ?", "rev");
        expect(stored).toBe(2);
      },
      { now: () => 0 },
    );
  });

  it("issues monotonically increasing revs inside a single transaction", async () => {
    await withDB(
      (db) => {
        let a: number | undefined;
        let b: number | undefined;
        db.transactionSync(() => {
          a = incrementRev(db);
          b = incrementRev(db);
        });
        expect(a).toBe(2);
        expect(b).toBe(3);
        const stored = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = ?", "rev");
        expect(stored).toBe(3);
      },
      { now: () => 0 },
    );
  });

  it("rolls back if the surrounding transaction aborts", async () => {
    await withDB(
      (db) => {
        expect(() => {
          db.transactionSync(() => {
            incrementRev(db);
            throw new Error("abort");
          });
        }).toThrow("abort");
        const stored = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = ?", "rev");
        expect(stored).toBe(1);
      },
      { now: () => 0 },
    );
  });
});
