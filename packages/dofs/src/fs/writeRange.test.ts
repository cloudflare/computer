import { describe, expect, it } from "vitest";

import type { Database } from "../storage.js";
import { link } from "./link.js";
import { mkdir } from "./mkdir.js";
import { readFile } from "./readFile.js";
import { resolveInode } from "./resolve.js";
import { symlink } from "./symlink.js";
import { withDB } from "./with-db.js";
import {
  CHUNK_SIZE,
  createFileSync,
  truncateFileSync,
  writeFileSync,
  writeRangeSync,
} from "./writeFile.js";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function readBytes(db: Database, path: string): Promise<Uint8Array> {
  const stream = await readFile(db, path);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function manifestHash(db: Database, path: string): Uint8Array | null {
  const node = resolveInode(db, path);
  if (node === null) throw new Error(`missing node: ${path}`);
  return (
    db.one<{ manifest_hash: Uint8Array | null }>(
      "SELECT manifest_hash FROM vfs_nodes WHERE inode = ?",
      node.inode,
    )?.manifest_hash ?? null
  );
}

function chunkRows(
  db: Database,
  path: string,
): Array<{ idx: number; hash: Uint8Array; size: number }> {
  const node = resolveInode(db, path);
  if (node === null) throw new Error(`missing node: ${path}`);
  return db.all<{ idx: number; hash: Uint8Array; size: number }>(
    "SELECT idx, hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
    node.inode,
  );
}

describe("direct range writes", () => {
  it("creates an empty file with no chunk rows", async () => {
    await withDB(async (db) => {
      createFileSync(db, "/empty.txt", { mode: 0o600 }, () => 1000);

      const node = resolveInode(db, "/empty.txt");
      expect(node?.type).toBe("file");
      expect(node?.mode).toBe(0o600);
      expect(chunkRows(db, "/empty.txt")).toEqual([]);
    });
  });

  it("invalidates a cached miss when creating through a symlinked parent", async () => {
    await withDB((db) => {
      mkdir(db, "/real", {}, () => 1000);
      symlink(db, "/real", "/linkdir", () => 1000);
      expect(resolveInode(db, "/real/file.txt")).toBeNull();

      createFileSync(db, "/linkdir/file.txt", {}, () => 1001);

      expect(resolveInode(db, "/real/file.txt")?.type).toBe("file");
    });
  });

  it("writes small ranges and stores them as a single chunk", async () => {
    await withDB(async (db) => {
      createFileSync(db, "/small.txt", {}, () => 1000);

      expect(writeRangeSync(db, "/small.txt", bytesOf("hello"), 0, {}, () => 1001)).toBe(5);
      expect(writeRangeSync(db, "/small.txt", bytesOf("y"), 4, {}, () => 1002)).toBe(1);

      expect(new TextDecoder().decode(await readBytes(db, "/small.txt"))).toBe("helly");
      expect(chunkRows(db, "/small.txt")).toHaveLength(1);
    });
  });

  it("zero-fills sparse writes", async () => {
    await withDB(async (db) => {
      createFileSync(db, "/sparse.txt", {}, () => 1000);

      writeRangeSync(db, "/sparse.txt", bytesOf("x"), 3, {}, () => 1001);

      expect(Array.from(await readBytes(db, "/sparse.txt"))).toEqual([0, 0, 0, 120]);
    });
  });

  it("updates only affected chunk hashes for chunk-backed files", async () => {
    await withDB(async (db) => {
      const original = new Uint8Array(CHUNK_SIZE * 3);
      original.fill(1, 0, CHUNK_SIZE);
      original.fill(2, CHUNK_SIZE, CHUNK_SIZE * 2);
      original.fill(3, CHUNK_SIZE * 2, CHUNK_SIZE * 3);
      writeFileSync(db, "/large.bin", original, {}, () => 1000);
      const before = chunkRows(db, "/large.bin");

      writeRangeSync(db, "/large.bin", new Uint8Array([9, 9, 9]), CHUNK_SIZE + 10, {}, () => 1001);
      const after = chunkRows(db, "/large.bin");

      expect(after).toHaveLength(3);
      expect(Buffer.from(after[0].hash).equals(Buffer.from(before[0].hash))).toBe(true);
      expect(Buffer.from(after[1].hash).equals(Buffer.from(before[1].hash))).toBe(false);
      expect(Buffer.from(after[2].hash).equals(Buffer.from(before[2].hash))).toBe(true);
      const bytes = await readBytes(db, "/large.bin");
      expect(bytes[CHUNK_SIZE + 9]).toBe(2);
      expect(Array.from(bytes.subarray(CHUNK_SIZE + 10, CHUNK_SIZE + 13))).toEqual([9, 9, 9]);
      expect(bytes[CHUNK_SIZE + 13]).toBe(2);
    });
  });

  it("writes through hardlinks by shared inode", async () => {
    await withDB(async (db) => {
      createFileSync(db, "/a.txt", {}, () => 1000);
      link(db, "/a.txt", "/b.txt");

      writeRangeSync(db, "/b.txt", bytesOf("shared"), 0, {}, () => 1001);

      expect(new TextDecoder().decode(await readBytes(db, "/a.txt"))).toBe("shared");
      expect(resolveInode(db, "/a.txt")?.inode).toBe(resolveInode(db, "/b.txt")?.inode);
    });
  });

  it("skips rewriting untouched chunks on a small range write", async () => {
    await withDB(async (db) => {
      const original = new Uint8Array(CHUNK_SIZE * 3);
      original.fill(1, 0, CHUNK_SIZE);
      original.fill(2, CHUNK_SIZE, CHUNK_SIZE * 2);
      original.fill(3, CHUNK_SIZE * 2, CHUNK_SIZE * 3);
      writeFileSync(db, "/large.bin", original, {}, () => 1000);

      // Touch only the middle chunk, at a later mtime.
      writeRangeSync(db, "/large.bin", new Uint8Array([7]), CHUNK_SIZE + 10, {}, () => 1001);

      // applyChunkedInodeUpdate skips SQL entirely for unchanged chunks,
      // so their blobs are never re-upserted and keep the original
      // last_seen; only the rewritten middle chunk's blob is stamped with
      // the new mtime. (vfs_chunks is WITHOUT ROWID, so there is no rowid
      // to watch. last_seen is bumped only by upsertChunkBlob, so an
      // unchanged last_seen proves the chunk row was skipped.)
      const rows = chunkRows(db, "/large.bin");
      expect(rows).toHaveLength(3);
      const lastSeen = (hash: Uint8Array): number | undefined =>
        db.one<{ last_seen: number }>("SELECT last_seen FROM vfs_blobs WHERE hash = ?", hash)
          ?.last_seen;
      expect(lastSeen(rows[0].hash)).toBe(1000);
      expect(lastSeen(rows[1].hash)).toBe(1001);
      expect(lastSeen(rows[2].hash)).toBe(1000);
    });
  });

  it("invalidates the manifest hash after a direct range write", async () => {
    await withDB(async (db) => {
      const original = new Uint8Array(CHUNK_SIZE * 2);
      original.fill(1, 0, CHUNK_SIZE);
      original.fill(2, CHUNK_SIZE);
      writeFileSync(db, "/large.bin", original, {}, () => 1000);
      expect(manifestHash(db, "/large.bin")).not.toBe(null);

      writeRangeSync(db, "/large.bin", new Uint8Array([5]), 10, {}, () => 1001);
      expect(manifestHash(db, "/large.bin")).toBe(null);
    });
  });

  it("truncates chunk-backed files without rewriting untouched chunks", async () => {
    await withDB(async (db) => {
      const original = new Uint8Array(CHUNK_SIZE * 2 + 100);
      original.fill(1, 0, CHUNK_SIZE);
      original.fill(2, CHUNK_SIZE, CHUNK_SIZE * 2);
      original.fill(3, CHUNK_SIZE * 2);
      writeFileSync(db, "/truncate.bin", original, {}, () => 1000);
      const before = chunkRows(db, "/truncate.bin");

      truncateFileSync(db, "/truncate.bin", CHUNK_SIZE + 50, () => 1001);
      const after = chunkRows(db, "/truncate.bin");

      expect(after).toHaveLength(2);
      expect(after[1].size).toBe(50);
      expect(Buffer.from(after[0].hash).equals(Buffer.from(before[0].hash))).toBe(true);
      expect(Buffer.from(after[1].hash).equals(Buffer.from(before[1].hash))).toBe(false);
      expect((await readBytes(db, "/truncate.bin")).byteLength).toBe(CHUNK_SIZE + 50);
    });
  });
});
