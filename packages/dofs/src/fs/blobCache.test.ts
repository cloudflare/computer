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

  it("evicts the least-recently-used entry once 17 distinct hashes are cached", async () => {
    await withDB(async (db) => {
      // Stage 17 files with distinct content so each one gets a
      // unique blob hash. The cache holds 16; the 17th fetch must
      // evict the least-recently-used, which is the first hash.
      const hashes: Uint8Array[] = [];
      for (let i = 0; i < 17; i++) {
        const path = `/distinct-${i}.bin`;
        writeFileSync(db, path, new TextEncoder().encode(`payload-${i}`), {}, () => 1);
        const row = db.one<{ hash: Uint8Array }>(
          "SELECT hash FROM vfs_chunks WHERE inode = (SELECT child_inode FROM vfs_dirents WHERE name = ?)",
          `distinct-${i}.bin`,
        );
        hashes.push(row?.hash as Uint8Array);
      }
      clearBlobCache(db);

      // First 16 fetches populate the cache.
      for (let i = 0; i < 16; i++) getBlobBytes(db, hashes[i]);
      // 17th fetch evicts the LRU (entry 0); spy to confirm the
      // 18th fetch of hash 0 is a fresh SQL lookup, but hash 16 is
      // cached and the 18th fetch of hash 1 (still the LRU) hits
      // SQL too.
      getBlobBytes(db, hashes[16]);

      const spy = vi.spyOn(db, "one");
      getBlobBytes(db, hashes[0]); // evicted, must hit SQL
      getBlobBytes(db, hashes[16]); // hot, must NOT hit SQL
      const lookups = spy.mock.calls.filter(
        ([query]) => typeof query === "string" && query.includes("vfs_blob_bytes"),
      ).length;
      spy.mockRestore();

      expect(lookups).toBe(1);
    });
  });

  it("moves a touched entry to most-recent so it survives eviction", async () => {
    await withDB(async (db) => {
      const hashes: Uint8Array[] = [];
      for (let i = 0; i < 17; i++) {
        const path = `/touched-${i}.bin`;
        writeFileSync(db, path, new TextEncoder().encode(`touched-${i}`), {}, () => 1);
        const row = db.one<{ hash: Uint8Array }>(
          "SELECT hash FROM vfs_chunks WHERE inode = (SELECT child_inode FROM vfs_dirents WHERE name = ?)",
          `touched-${i}.bin`,
        );
        hashes.push(row?.hash as Uint8Array);
      }
      clearBlobCache(db);

      for (let i = 0; i < 16; i++) getBlobBytes(db, hashes[i]);
      // Touch hash 0 so it becomes most-recent.
      getBlobBytes(db, hashes[0]);
      // The 17th fetch should now evict hash 1, not hash 0.
      getBlobBytes(db, hashes[16]);

      const spy = vi.spyOn(db, "one");
      getBlobBytes(db, hashes[0]); // touched, still cached
      getBlobBytes(db, hashes[1]); // evicted, must hit SQL
      const lookups = spy.mock.calls.filter(
        ([query]) => typeof query === "string" && query.includes("vfs_blob_bytes"),
      ).length;
      spy.mockRestore();

      expect(lookups).toBe(1);
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
