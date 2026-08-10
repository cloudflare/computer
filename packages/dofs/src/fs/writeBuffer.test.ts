import { describe, expect, it } from "vitest";

import type { Database } from "../storage.js";
import { mkdir } from "./mkdir.js";
import { readRangeSync } from "./readFile.js";
import { resolveInode } from "./resolve.js";
import { stat } from "./stat.js";
import { symlink } from "./symlink.js";
import { withDB } from "./with-db.js";
import {
  CHUNK_SIZE,
  createFileSync,
  openWriteBufferForCreateSync,
  openWriteBufferSync,
  releaseWriteBufferSync,
  truncateFileSync,
  writeRangeSync,
} from "./writeFile.js";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function blobCount(db: Database): number {
  return db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs") ?? 0;
}

function orphanBlobCount(db: Database): number {
  return (
    db.scalar<number>(
      "SELECT COUNT(*) FROM vfs_blobs b WHERE NOT EXISTS (SELECT 1 FROM vfs_chunks c WHERE c.hash = b.hash)",
    ) ?? 0
  );
}

function chunkCount(db: Database, path: string): number {
  const node = resolveInode(db, path);
  if (node === null) throw new Error(`missing node: ${path}`);
  return db.scalar<number>("SELECT COUNT(*) FROM vfs_chunks WHERE inode = ?", node.inode) ?? 0;
}

describe("buffered write lifecycle", () => {
  it("buffers many small writes and stages blobs only on release", async () => {
    await withDB(async (db) => {
      createFileSync(db, "/buffered.bin", {}, () => 1000);
      openWriteBufferSync(db, "/buffered.bin");

      const big = new Uint8Array(CHUNK_SIZE);
      big.fill(7);
      // Write the same chunk-sized payload eight times at offset 0.
      // Pre-buffer, each write would stage one orphan blob per
      // intermediate state.
      for (let i = 0; i < 8; i++) {
        writeRangeSync(db, "/buffered.bin", big, 0, {}, () => 1001 + i);
      }
      // While the buffer is open we keep no chunk or blob rows yet.
      expect(blobCount(db)).toBe(0);

      releaseWriteBufferSync(db, "/buffered.bin", () => 1100);

      // After release: exactly one blob, no orphans, content matches.
      expect(blobCount(db)).toBe(1);
      expect(orphanBlobCount(db)).toBe(0);
      const final = readRangeSync(db, "/buffered.bin", 0, CHUNK_SIZE);
      expect(final.byteLength).toBe(CHUNK_SIZE);
      expect(final[0]).toBe(7);
    });
  });

  it("serves buffered reads before release", async () => {
    await withDB(async (db) => {
      createFileSync(db, "/buffered.txt", {}, () => 1000);
      openWriteBufferSync(db, "/buffered.txt");

      writeRangeSync(db, "/buffered.txt", bytesOf("hello"), 0, {}, () => 1001);
      // Reading through the same db sees the buffered bytes even
      // though no chunk row has been written.
      expect(new TextDecoder().decode(readRangeSync(db, "/buffered.txt", 0, 5))).toBe("hello");
      expect(chunkCount(db, "/buffered.txt")).toBe(0);

      releaseWriteBufferSync(db, "/buffered.txt", () => 1100);
      expect(new TextDecoder().decode(readRangeSync(db, "/buffered.txt", 0, 5))).toBe("hello");
    });
  });

  it("truncate updates the buffer instead of rewriting chunks", async () => {
    await withDB(async (db) => {
      createFileSync(db, "/trunc.bin", {}, () => 1000);
      openWriteBufferSync(db, "/trunc.bin");

      const payload = new Uint8Array(CHUNK_SIZE * 2);
      payload.fill(1);
      writeRangeSync(db, "/trunc.bin", payload, 0, {}, () => 1001);
      truncateFileSync(db, "/trunc.bin", CHUNK_SIZE - 100, () => 1002);
      expect(chunkCount(db, "/trunc.bin")).toBe(0);

      releaseWriteBufferSync(db, "/trunc.bin", () => 1100);
      expect(chunkCount(db, "/trunc.bin")).toBe(1);
      const final = readRangeSync(db, "/trunc.bin", 0, CHUNK_SIZE);
      expect(final.byteLength).toBe(CHUNK_SIZE - 100);
    });
  });

  it("hardlinks share the same buffered bytes by inode", async () => {
    await withDB(async (db) => {
      createFileSync(db, "/a.txt", {}, () => 1000);
      // Both paths point at the same inode. Open under /a.txt, then
      // write under /b.txt: the buffer is keyed by inode so the write
      // lands in the same cache entry.
      const { link } = await import("./link.js");
      link(db, "/a.txt", "/b.txt");
      openWriteBufferSync(db, "/a.txt");

      // Multiple intermediate writes through both paths. Pre-buffer
      // each one would have staged its own blob and orphaned the
      // previous state; the buffer keeps them in memory until release.
      writeRangeSync(db, "/b.txt", bytesOf("step-1"), 0, {}, () => 1001);
      writeRangeSync(db, "/a.txt", bytesOf("step-2"), 0, {}, () => 1002);
      writeRangeSync(db, "/b.txt", bytesOf("shared"), 0, {}, () => 1003);
      expect(new TextDecoder().decode(readRangeSync(db, "/a.txt", 0, 6))).toBe("shared");
      expect(blobCount(db)).toBe(0);

      releaseWriteBufferSync(db, "/a.txt", () => 1100);
      expect(new TextDecoder().decode(readRangeSync(db, "/b.txt", 0, 6))).toBe("shared");
      // Exactly one blob for the final state, regardless of how many
      // intermediate writes the open window saw.
      expect(blobCount(db)).toBe(1);
    });
  });

  it("commits a chunked file with one blob per chunk on release", async () => {
    await withDB(async (db) => {
      createFileSync(db, "/big.bin", {}, () => 1000);
      openWriteBufferSync(db, "/big.bin");

      // Three chunks of distinct content. Pre-buffer, each write
      // would create the chunk row eagerly and a partial-tail write
      // would create an orphan blob for the previous tail size.
      const payload = new Uint8Array(CHUNK_SIZE * 3);
      payload.fill(1, 0, CHUNK_SIZE);
      payload.fill(2, CHUNK_SIZE, CHUNK_SIZE * 2);
      payload.fill(3, CHUNK_SIZE * 2);
      writeRangeSync(db, "/big.bin", payload, 0, {}, () => 1001);

      releaseWriteBufferSync(db, "/big.bin", () => 1100);
      expect(chunkCount(db, "/big.bin")).toBe(3);
      expect(orphanBlobCount(db)).toBe(0);
    });
  });
});

describe("deferred-create lifecycle", () => {
  it("holds the file in memory until release commits one transaction", async () => {
    await withDB(async (db) => {
      openWriteBufferForCreateSync(db, "/pending.txt", { mode: 0o600 }, () => 1000);

      // No SQL row exists yet but the path is reachable via the
      // path-keyed pending cache: stat, read, and write all see it.
      expect(stat(db, "/pending.txt").size).toBe(0);
      writeRangeSync(db, "/pending.txt", bytesOf("hello"), 0, {}, () => 1001);
      expect(stat(db, "/pending.txt").size).toBe(5);
      expect(new TextDecoder().decode(readRangeSync(db, "/pending.txt", 0, 5))).toBe("hello");
      expect(resolveInode(db, "/pending.txt")).toBeNull();
      expect(blobCount(db)).toBe(0);

      releaseWriteBufferSync(db, "/pending.txt", () => 1100);

      // Release committed the INSERT, dirent, and chunk rows in one
      // transaction; the path now resolves to a real inode and the
      // stat sees the persisted size.
      const node = resolveInode(db, "/pending.txt");
      expect(node?.type).toBe("file");
      expect(node?.mode).toBe(0o600);
      expect(stat(db, "/pending.txt").size).toBe(5);
      expect(blobCount(db)).toBe(1);
      expect(orphanBlobCount(db)).toBe(0);
    });
  });

  it("invalidates the real path after releasing through a symlinked parent", async () => {
    await withDB((db) => {
      mkdir(db, "/real", {}, () => 1000);
      symlink(db, "/real", "/linkdir", () => 1000);
      expect(resolveInode(db, "/real/pending.txt")).toBeNull();

      openWriteBufferForCreateSync(db, "/linkdir/pending.txt", {}, () => 1000);
      writeRangeSync(db, "/linkdir/pending.txt", bytesOf("hello"), 0, {}, () => 1001);
      releaseWriteBufferSync(db, "/linkdir/pending.txt", () => 1002);

      expect(resolveInode(db, "/real/pending.txt")?.type).toBe("file");
    });
  });

  it("rejects a second openWriteBufferForCreateSync against the same path", async () => {
    await withDB(async (db) => {
      openWriteBufferForCreateSync(db, "/dupe.txt", {}, () => 1000);
      expect(() => openWriteBufferForCreateSync(db, "/dupe.txt", {}, () => 1001)).toThrowError(
        expect.objectContaining({ code: "EEXIST" }),
      );
    });
  });

  it("surfaces pending files in readdir before release", async () => {
    await withDB(async (db) => {
      const { readdir } = await import("./readdir.js");
      const { mkdir } = await import("./mkdir.js");
      mkdir(db, "/d", {}, () => 1000);
      openWriteBufferForCreateSync(db, "/d/pending.txt", {}, () => 1001);

      const names = readdir(db, "/d").map((entry) => entry.name);
      expect(names).toEqual(["pending.txt"]);

      releaseWriteBufferSync(db, "/d/pending.txt", () => 1100);
      const after = readdir(db, "/d").map((entry) => entry.name);
      expect(after).toEqual(["pending.txt"]);
    });
  });

  it("defers commit until the matching release count is reached", async () => {
    await withDB(async (db) => {
      createFileSync(db, "/multi.txt", {}, () => 1000);
      writeRangeSync(db, "/multi.txt", bytesOf("seed"), 0, {}, () => 1001);
      // Establish the on-disk shape we'll observe against.
      const seedBlobs = blobCount(db);
      const seedChunks = chunkCount(db, "/multi.txt");

      // Two opens of the same path share a single inode-keyed entry.
      openWriteBufferSync(db, "/multi.txt");
      openWriteBufferSync(db, "/multi.txt");
      writeRangeSync(db, "/multi.txt", bytesOf("DIRTY"), 0, {}, () => 1002);

      // First release decrements but does not commit — chunk/blob
      // shape unchanged.
      releaseWriteBufferSync(db, "/multi.txt", () => 1003);
      expect(blobCount(db)).toBe(seedBlobs);
      expect(chunkCount(db, "/multi.txt")).toBe(seedChunks);

      // Second release commits. Reading back through the chunk
      // store sees the dirty bytes.
      releaseWriteBufferSync(db, "/multi.txt", () => 1004);
      const final = readRangeSync(db, "/multi.txt", 0, 5);
      expect(new TextDecoder().decode(final)).toBe("DIRTY");

      // A fresh open after release starts a clean buffer; an
      // immediate release without writes is a no-op.
      openWriteBufferSync(db, "/multi.txt");
      releaseWriteBufferSync(db, "/multi.txt", () => 1005);
      // No corruption: file content still matches.
      const stable = readRangeSync(db, "/multi.txt", 0, 5);
      expect(new TextDecoder().decode(stable)).toBe("DIRTY");
    });
  });

  it("flushPendingByPath promotes the buffer without consuming the open count", async () => {
    const { flushPendingByPath } = await import("./writeFile.js");
    await withDB(async (db) => {
      openWriteBufferForCreateSync(db, "/promote.txt", {}, () => 1000);
      writeRangeSync(db, "/promote.txt", bytesOf("before"), 0, {}, () => 1001);
      expect(resolveInode(db, "/promote.txt")).toBeNull();

      // Promote the pending entry without releasing it.
      const committed = flushPendingByPath(db, "/promote.txt", () => 1002);
      expect(committed).toBe(true);

      // The path now resolves; the open buffer survived the
      // promotion under the real inode key.
      const node = resolveInode(db, "/promote.txt");
      expect(node?.type).toBe("file");
      expect(chunkCount(db, "/promote.txt")).toBeGreaterThan(0);

      // Further writes route through the inode-keyed cache. The
      // matching release commits the final bytes over the
      // promoted state.
      writeRangeSync(db, "/promote.txt", bytesOf("after-x"), 0, {}, () => 1003);
      releaseWriteBufferSync(db, "/promote.txt", () => 1004);
      const final = readRangeSync(db, "/promote.txt", 0, 7);
      expect(new TextDecoder().decode(final)).toBe("after-x");
    });
  });

  it("flushPendingByPath returns false when no pending buffer is open", async () => {
    const { flushPendingByPath } = await import("./writeFile.js");
    await withDB(async (db) => {
      createFileSync(db, "/already.txt", {}, () => 1000);
      expect(flushPendingByPath(db, "/already.txt", () => 1001)).toBe(false);
      expect(flushPendingByPath(db, "/missing.txt", () => 1002)).toBe(false);
    });
  });
});
