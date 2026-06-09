import { describe, expect, it, vi } from "vitest";

import type { Database } from "../storage.js";
import { clearBlobCache, getBlobBytes } from "./blobCache.js";
import { readRangeSync } from "./readFile.js";
import { withDB } from "./with-db.js";
import { CHUNK_SIZE, writeFileSync } from "./writeFile.js";

describe("blobCache", () => {
  it("reuses bytes for the same hash across calls", async () => {
    await withDB(async (db) => {
      writeFileSync(db, "/seed.bin", new Uint8Array(CHUNK_SIZE).fill(7), {}, () => 1);
      // Pull the chunk hash out of vfs_chunks so we can hit the
      // cache helper directly without going through readFile.
      const row = db.one<{ hash: Uint8Array }>(
        "SELECT hash FROM vfs_chunks WHERE inode = (SELECT child_inode FROM vfs_dirents WHERE name = ?)",
        "seed.bin",
      );
      expect(row).toBeDefined();
      const hash = row?.hash as Uint8Array;

      // First call populates the cache; the second returns the
      // exact same Uint8Array reference rather than re-querying.
      const first = getBlobBytes(db, hash);
      expect(first).toBeInstanceOf(Uint8Array);
      const second = getBlobBytes(db, hash);
      expect(second).toBe(first);
    });
  });

  it("readRangeSync avoids repeating vfs_blob_bytes lookups on sequential reads", async () => {
    await withDB(async (db) => {
      // 4 MiB of repeated content → one dedup'd blob in the store.
      // A sequential read in 128 KiB windows used to issue one
      // SELECT bytes per window, even though every window came out
      // of the same blob.
      const payload = new Uint8Array(CHUNK_SIZE * 8).fill(3);
      writeFileSync(db, "/big.bin", payload, {}, () => 1);
      clearBlobCache(db);

      const spy = vi.spyOn(db, "one");
      const window = 128 * 1024;
      for (let offset = 0; offset < payload.byteLength; offset += window) {
        readRangeSync(db, "/big.bin", offset, window);
      }
      const blobLookups = spy.mock.calls.filter(
        ([query]) => typeof query === "string" && query.includes("vfs_blob_bytes"),
      ).length;
      spy.mockRestore();

      // 8 distinct chunks were written and they all share one
      // hash; we should fetch the blob bytes at most once.
      expect(blobLookups).toBeLessThanOrEqual(1);
    });
  });
});
