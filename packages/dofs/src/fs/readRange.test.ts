import { describe, expect, it } from "vitest";

import { readRangeSync } from "./readFile.js";
import { resolveInode } from "./resolve.js";
import { withDB } from "./with-db.js";
import {
  CHUNK_SIZE,
  openWriteBufferSync,
  releaseWriteBufferSync,
  writeFileSync,
  writeRangeSync,
} from "./writeFile.js";

describe("readRangeSync", () => {
  it("reads small chunk-backed files at non-zero offset", async () => {
    await withDB((db) => {
      writeFileSync(db, "/inline.txt", new TextEncoder().encode("hello world"), {}, () => 1);

      const slice = readRangeSync(db, "/inline.txt", 6, 5);
      expect(new TextDecoder().decode(slice)).toBe("world");
    });
  });

  it("clamps the read at end of file", async () => {
    await withDB((db) => {
      writeFileSync(db, "/inline.txt", new TextEncoder().encode("abc"), {}, () => 1);

      expect(readRangeSync(db, "/inline.txt", 0, 100).byteLength).toBe(3);
      expect(readRangeSync(db, "/inline.txt", 2, 100).byteLength).toBe(1);
      expect(readRangeSync(db, "/inline.txt", 3, 100).byteLength).toBe(0);
    });
  });

  it("returns owned bytes while a write buffer is open", async () => {
    await withDB((db) => {
      writeFileSync(db, "/bin", new Uint8Array([1, 2, 3]), {}, () => 1);
      openWriteBufferSync(db, "/bin");
      writeRangeSync(db, "/bin", new Uint8Array([4, 5, 6]), 0, {}, () => 1);

      const range = readRangeSync(db, "/bin", 0, 3);
      range[0] = 99;

      expect(Array.from(readRangeSync(db, "/bin", 0, 3))).toEqual([4, 5, 6]);
      releaseWriteBufferSync(db, "/bin", () => 2);
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

  it("assembles a read spanning multiple chunks with partial ends", async () => {
    await withDB((db) => {
      const original = new Uint8Array(CHUNK_SIZE * 3);
      original.fill(1, 0, CHUNK_SIZE);
      original.fill(2, CHUNK_SIZE, CHUNK_SIZE * 2);
      original.fill(3, CHUNK_SIZE * 2);
      writeFileSync(db, "/large.bin", original, {}, () => 1);

      // Start inside chunk 0 and end inside chunk 2, so the range query
      // returns all three rows and they must assemble in idx order with
      // correct partial-chunk trimming.
      const start = CHUNK_SIZE - 3;
      const len = CHUNK_SIZE + 6;
      const slice = readRangeSync(db, "/large.bin", start, len);
      expect(slice.byteLength).toBe(len);
      expect(equalBytes(slice, original.subarray(start, start + len))).toBe(true);
    });
  });

  it("reads an entire multi-chunk file byte-for-byte", async () => {
    await withDB((db) => {
      const original = new Uint8Array(CHUNK_SIZE * 2 + 50);
      for (let i = 0; i < original.byteLength; i++) original[i] = i % 251;
      writeFileSync(db, "/large.bin", original, {}, () => 1);

      const slice = readRangeSync(db, "/large.bin", 0, original.byteLength);
      expect(equalBytes(slice, original)).toBe(true);
    });
  });

  it("throws EIO when a chunk row is missing", async () => {
    await withDB((db) => {
      const original = new Uint8Array(CHUNK_SIZE * 3);
      writeFileSync(db, "/large.bin", original, {}, () => 1);
      const node = resolveInode(db, "/large.bin");
      db.run("DELETE FROM vfs_chunks WHERE inode = ? AND idx = 1", node?.inode ?? 0);

      expect(() => readRangeSync(db, "/large.bin", 0, CHUNK_SIZE * 3)).toThrowError(
        expect.objectContaining({ code: "EIO" }),
      );
    });
  });

  it("throws EIO when a referenced chunk's blob bytes are gone", async () => {
    await withDB((db) => {
      writeFileSync(db, "/inline.txt", new TextEncoder().encode("hello"), {}, () => 1);
      // vfs_chunks still references the hash, but the bytes are gone
      // (cascade from vfs_blobs) — a read must surface EIO.
      db.run("DELETE FROM vfs_blobs");

      expect(() => readRangeSync(db, "/inline.txt", 0, 5)).toThrowError(
        expect.objectContaining({ code: "EIO" }),
      );
    });
  });
});

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
