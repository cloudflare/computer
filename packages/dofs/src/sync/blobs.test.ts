import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gc } from "../fs/gc.js";
import { withDB } from "../fs/with-db.js";
import { writeFile } from "../fs/writeFile.js";
import { Database } from "../storage.js";
import { stageBlob } from "./blobs.js";

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

describe("stageBlob", () => {
  it("lands a chunk into vfs_blobs + vfs_blob_bytes", async () => {
    await withDB(async (db) => {
      const bytes = new TextEncoder().encode("payload");
      const hash = sha256(bytes);
      stageBlob(db, hash, bytes, 1234);
      const blob = db.one<{ size: number; last_seen: number }>(
        "SELECT size, last_seen FROM vfs_blobs WHERE hash = ?",
        hash,
      );
      expect(blob?.size).toBe(7);
      expect(blob?.last_seen).toBe(1234);
      const row = db.one<{ bytes: Uint8Array }>(
        "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
        hash,
      );
      expect(row?.bytes).toEqual(bytes);
    });
  });

  it("rolls back metadata and bytes when storing the bytes fails", async () => {
    await withDB(async (db) => {
      const bytes = new TextEncoder().encode("payload");
      const hash = sha256(bytes);
      const failingDb = new Database({
        sql: {
          exec: <Row extends object>(query: string, ...bindings: unknown[]) => {
            if (query.startsWith("INSERT INTO vfs_blob_bytes")) {
              throw new Error("injected bytes failure");
            }
            return db.sql.exec<Row>(query, ...bindings);
          },
        },
        transactionSync: (closure) => db.transactionSync(closure),
      });

      expect(() => stageBlob(failingDb, hash, bytes, 1234)).toThrow("injected bytes failure");
      expect(db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs")).toBe(0);
      expect(db.scalar<number>("SELECT COUNT(*) FROM vfs_blob_bytes")).toBe(0);
    });
  });

  it("is idempotent: a second call refreshes last_seen but leaves bytes alone", async () => {
    await withDB(async (db) => {
      const bytes = new TextEncoder().encode("same");
      const hash = sha256(bytes);
      stageBlob(db, hash, bytes, 100);
      stageBlob(db, hash, bytes, 200);
      const blob = db.one<{ last_seen: number }>(
        "SELECT last_seen FROM vfs_blobs WHERE hash = ?",
        hash,
      );
      expect(blob?.last_seen).toBe(200);
      // Still one row.
      const count = db.scalar<number>("SELECT COUNT(*) FROM vfs_blob_bytes");
      expect(count).toBe(1);
    });
  });

  it("a staged-but-unreferenced blob is reaped by gc outside the safety window", async () => {
    await withDB(async (db) => {
      const bytes = new TextEncoder().encode("orphan");
      const hash = sha256(bytes);
      stageBlob(db, hash, bytes, 100);
      // Inside the safety window, gc preserves it.
      expect(gc(db, { now: () => 200, safetyWindowMs: 1000 }).blobsFreed).toBe(0);
      // Outside, gc reaps it.
      expect(gc(db, { now: () => 5000, safetyWindowMs: 1000 }).blobsFreed).toBe(1);
    });
  });

  it("dedups against a blob already written by writeFile", async () => {
    await withDB(async (db) => {
      const bytes = new TextEncoder().encode("shared");
      const hash = sha256(bytes);
      await writeFile(db, "/a.txt", "shared", {}, () => 1);
      // The writeFile path already wrote the blob with that hash.
      const before = db.scalar<number>("SELECT COUNT(*) FROM vfs_blob_bytes");
      stageBlob(db, hash, bytes, 5000);
      const after = db.scalar<number>("SELECT COUNT(*) FROM vfs_blob_bytes");
      expect(after).toBe(before);
      // last_seen on the blob row has been bumped.
      const ls = db.scalar<number>("SELECT last_seen FROM vfs_blobs WHERE hash = ?", hash);
      expect(ls).toBe(5000);
    });
  });
});
