import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Database } from "../storage.js";
import { applyChanges } from "../sync/apply.js";
import { stageBlob } from "../sync/blobs.js";
import { gc } from "./gc.js";
import { readFile } from "./readFile.js";
import { rm } from "./rm.js";
import { withDB } from "./with-db.js";
import { writeFile } from "./writeFile.js";

function blobCount(db: Database): number {
  return db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs") ?? 0;
}

function blobBytesCount(db: Database): number {
  return db.scalar<number>("SELECT COUNT(*) FROM vfs_blob_bytes") ?? 0;
}

describe("gc", () => {
  it("returns { blobsFreed: 0, manifestsFreed: 0 } on an empty FS", async () => {
    await withDB((db) => {
      expect(gc(db, { now: () => 1_000_000 })).toEqual({ blobsFreed: 0, manifestsFreed: 0 });
    });
  });

  it("does not free blobs that are still referenced", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "live content", {}, () => 1000);
      expect(blobCount(db)).toBe(1);
      expect(gc(db, { now: () => 999_999_999 })).toEqual({
        blobsFreed: 0,
        manifestsFreed: 0,
      });
      expect(blobCount(db)).toBe(1);
    });
  });

  it("does not free blobs a sync apply linked", async () => {
    await withDB(async (db) => {
      // A pull stages chunks before linking them, so vfs_chunks reachability
      // must protect blobs independently of their staging timestamp.
      const bytes = new TextEncoder().encode("staged content");
      const hash = new Uint8Array(createHash("sha256").update(bytes).digest());
      stageBlob(db, hash, bytes, 1000);

      await applyChanges(
        db,
        [
          {
            kind: "file",
            rev: 1,
            path: "/staged.txt",
            mode: 0o644,
            mtime: 1000,
            size: bytes.byteLength,
            chunks: [{ hash, size: bytes.byteLength }],
          },
        ],
        new Map(),
        { source: "upstream" },
      );
      expect(blobCount(db)).toBe(1);

      // A zero safety window and far-future clock make every blob stale;
      // only references from vfs_chunks protect this blob and manifest.
      expect(gc(db, { now: () => 999_999_999, safetyWindowMs: 0 })).toEqual({
        blobsFreed: 0,
        manifestsFreed: 0,
      });
      expect(blobCount(db)).toBe(1);
      expect(blobBytesCount(db)).toBe(1);
      expect(await readFile(db, "/staged.txt", "utf8")).toBe("staged content");
    });
  });

  it("frees orphan blobs left behind by overwrite", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/x.txt", "first", {}, () => 1000);
      await writeFile(db, "/x.txt", "second", {}, () => 1000);
      // Both blobs exist; the 'first' content is orphaned.
      expect(blobCount(db)).toBe(2);

      const result = gc(db, { now: () => 2000, safetyWindowMs: 0 });
      expect(result.blobsFreed).toBe(1);
      expect(blobCount(db)).toBe(1);
      // The remaining blob is the one referenced by the current chunk.
      const referenced = db.scalar<number>(
        "SELECT COUNT(*) FROM vfs_blobs b WHERE EXISTS (SELECT 1 FROM vfs_chunks c WHERE c.hash = b.hash)",
      );
      expect(referenced).toBe(1);
    });
  });

  it("cascades the delete to vfs_blob_bytes", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/x.txt", "first", {}, () => 1000);
      await writeFile(db, "/x.txt", "second", {}, () => 1000);
      expect(blobBytesCount(db)).toBe(2);
      gc(db, { now: () => 2000, safetyWindowMs: 0 });
      expect(blobBytesCount(db)).toBe(1);
    });
  });

  it("frees orphan blobs left behind by rm", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "unique-content", {}, () => 1000);
      expect(blobCount(db)).toBe(1);
      rm(db, "/a.txt", {});
      expect(blobCount(db)).toBe(1); // rm doesn't sweep blobs
      const result = gc(db, { now: () => 2000, safetyWindowMs: 0 });
      expect(result.blobsFreed).toBe(1);
      expect(blobCount(db)).toBe(0);
    });
  });

  it("respects the safety window", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/x.txt", "first", {}, () => 1000);
      await writeFile(db, "/x.txt", "second", {}, () => 1000);
      // Inside the safety window the orphan stays.
      expect(gc(db, { now: () => 1500, safetyWindowMs: 1_000 })).toEqual({
        blobsFreed: 0,
        manifestsFreed: 0,
      });
      expect(blobCount(db)).toBe(2);
      // Outside the window it gets swept.
      expect(gc(db, { now: () => 5000, safetyWindowMs: 1_000 })).toEqual({
        blobsFreed: 1,
        manifestsFreed: 1,
      });
      expect(blobCount(db)).toBe(1);
    });
  });

  it("uses a conservative default safety window when none is provided", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/x.txt", "first", {}, () => 1000);
      await writeFile(db, "/x.txt", "second", {}, () => 1000);
      // The default is conservative enough that a small elapsed time
      // does not sweep anything.
      expect(gc(db, { now: () => 1500 })).toEqual({ blobsFreed: 0, manifestsFreed: 0 });
      expect(blobCount(db)).toBe(2);
    });
  });
});
