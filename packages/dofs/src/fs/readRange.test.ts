import { describe, expect, it } from "vitest";

import { readRangeSync } from "./readFile.js";
import { withDB } from "./with-db.js";
import { CHUNK_SIZE, writeFileSync } from "./writeFile.js";

describe("readRangeSync", () => {
  it("reads from inline files at non-zero offset", async () => {
    await withDB((db) => {
      writeFileSync(db, "/inline.txt", new TextEncoder().encode("hello world"), {}, () => 1);

      const slice = readRangeSync(db, "/inline.txt", 6, 5);
      expect(new TextDecoder().decode(slice)).toBe("world");
    });
  });

  it("clamps the inline read at end of file", async () => {
    await withDB((db) => {
      writeFileSync(db, "/inline.txt", new TextEncoder().encode("abc"), {}, () => 1);

      expect(readRangeSync(db, "/inline.txt", 0, 100).byteLength).toBe(3);
      expect(readRangeSync(db, "/inline.txt", 2, 100).byteLength).toBe(1);
      expect(readRangeSync(db, "/inline.txt", 3, 100).byteLength).toBe(0);
    });
  });

  it("reads a single chunk window without materializing other chunks", async () => {
    await withDB((db) => {
      const original = new Uint8Array(CHUNK_SIZE * 3);
      original.fill(1, 0, CHUNK_SIZE);
      original.fill(2, CHUNK_SIZE, CHUNK_SIZE * 2);
      original.fill(3, CHUNK_SIZE * 2);
      writeFileSync(db, "/large.bin", original, {}, () => 1);

      const slice = readRangeSync(db, "/large.bin", CHUNK_SIZE + 10, 5);
      expect(Array.from(slice)).toEqual([2, 2, 2, 2, 2]);
    });
  });

  it("reads across a chunk boundary", async () => {
    await withDB((db) => {
      const original = new Uint8Array(CHUNK_SIZE + 100);
      original.fill(1, 0, CHUNK_SIZE);
      original.fill(2, CHUNK_SIZE);
      writeFileSync(db, "/large.bin", original, {}, () => 1);

      const slice = readRangeSync(db, "/large.bin", CHUNK_SIZE - 2, 4);
      expect(Array.from(slice)).toEqual([1, 1, 2, 2]);
    });
  });

  it("returns an empty view past the end of a chunk-backed file", async () => {
    await withDB((db) => {
      const original = new Uint8Array(CHUNK_SIZE + 1);
      original.fill(7);
      writeFileSync(db, "/large.bin", original, {}, () => 1);

      expect(readRangeSync(db, "/large.bin", CHUNK_SIZE + 1, 10).byteLength).toBe(0);
    });
  });
});
