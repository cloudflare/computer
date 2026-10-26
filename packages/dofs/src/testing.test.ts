import { describe, expect, it } from "vitest";

import { initializeSchema, ROOT_INODE } from "./schema/index";
import { Database } from "./storage";
import { SQLiteTestStorage } from "./testing";

describe("SQLiteTestStorage", () => {
  it("backs a real in-memory database that initializeSchema can apply", () => {
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);

    initializeSchema(db, () => 1234);

    const row = db.one<{ inode: number; type: string; mtime: number }>(
      "SELECT inode, type, mtime FROM vfs_nodes WHERE inode = ?",
      ROOT_INODE,
    );
    expect(row).toEqual({ inode: ROOT_INODE, type: "dir", mtime: 1234 });
  });

  it("runs transactionSync atomically", () => {
    const storage = new SQLiteTestStorage();
    const db = new Database(storage);
    initializeSchema(db, () => 0);

    expect(() => {
      db.transactionSync(() => {
        db.run("INSERT INTO vfs_meta (k, v) VALUES (?, ?)", "rollback_probe", 1);
        throw new Error("forced");
      });
    }).toThrow("forced");

    const value = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = ?", "rollback_probe");
    expect(value).toBeUndefined();
  });
});
