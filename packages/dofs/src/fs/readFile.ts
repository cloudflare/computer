import { createWorkspaceError } from "../errors.js";
import type { Database } from "../storage.js";
import { resolveInode } from "./resolve.js";
import { getWriteBuffer } from "./writeBuffer.js";
import { CHUNK_SIZE } from "./writeFile.js";

export interface ReadFileOptions {
  encoding?: "utf8";
}

interface ChunkRow {
  hash: Uint8Array;
  size: number;
}

// Overloads match docs/04_filesystem_interface.md exactly.
export function readFile(db: Database, path: string): Promise<ReadableStream<Uint8Array>>;
export function readFile(
  db: Database,
  path: string,
  encoding: "utf8",
  now?: () => number,
): Promise<string>;
export function readFile(
  db: Database,
  path: string,
  options: ReadFileOptions,
  now?: () => number,
): Promise<string | ReadableStream<Uint8Array>>;
export async function readFile(
  db: Database,
  path: string,
  optionsOrEncoding?: "utf8" | ReadFileOptions,
  now: () => number = Date.now,
): Promise<string | ReadableStream<Uint8Array>> {
  const wantString =
    optionsOrEncoding === "utf8" ||
    (typeof optionsOrEncoding === "object" && optionsOrEncoding?.encoding === "utf8");

  // Resolve up front so we surface ENOENT/EISDIR before doing any
  // streaming work.
  const node = resolveInode(db, path);
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
  }
  if (node.type !== "file") {
    throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
  }

  // While a write buffer is open for this inode it is the source of
  // truth. Skip the chunk store and serve the buffered bytes.
  const buffered = getWriteBuffer(db, node.inode);
  if (buffered !== undefined && buffered.dirty) {
    const snapshot = new Uint8Array(buffered.size);
    snapshot.set(buffered.buf.subarray(0, buffered.size));
    if (wantString) return new TextDecoder().decode(snapshot);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(snapshot);
        controller.close();
      },
    });
  }

  const chunks = db.all<ChunkRow>(
    "SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
    node.inode,
  );

  if (wantString) {
    // Fast path — concatenate everything and decode once. Matches the
    // node:fs/promises.readFile semantics for an encoding argument:
    // memory cost = whole file.
    const totalSize = chunks.reduce((acc, c) => acc + c.size, 0);
    const out = new Uint8Array(totalSize);
    let offset = 0;
    const touched = now();
    for (const chunk of chunks) {
      const row = db.one<{ bytes: Uint8Array }>(
        "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
        chunk.hash,
      );
      if (row === undefined) {
        throw createWorkspaceError("EIO", `missing blob bytes for ${path}`, path);
      }
      out.set(row.bytes, offset);
      offset += row.bytes.byteLength;
    }
    if (chunks.length > 0) {
      touchBlobs(db, chunks, touched);
    }
    return new TextDecoder().decode(out);
  }

  // Stream form. We enqueue one Uint8Array per chunk, lazily pulled.
  // last_seen is touched per chunk on read; that's the GC clock signal
  // documented in 03_filesystem_schema.md.
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[i++];
      const row = db.one<{ bytes: Uint8Array }>(
        "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
        chunk.hash,
      );
      if (row === undefined) {
        controller.error(createWorkspaceError("EIO", `missing blob bytes for ${path}`, path));
        return;
      }
      db.run("UPDATE vfs_blobs SET last_seen = ? WHERE hash = ?", now(), chunk.hash);
      controller.enqueue(row.bytes);
    },
  });
}

// Positional read primitive. Walks only the chunk rows that overlap
// [offset, offset+length), so the FUSE driver can serve a kernel
// read without materializing the whole file.
export function readRangeSync(
  db: Database,
  path: string,
  offset: number,
  length: number,
): Uint8Array {
  if (!Number.isInteger(offset) || offset < 0) {
    throw createWorkspaceError("EINVAL", `invalid read offset: ${offset}`, path);
  }
  if (!Number.isInteger(length) || length < 0) {
    throw createWorkspaceError("EINVAL", `invalid read length: ${length}`, path);
  }
  const node = resolveInode(db, path);
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
  }
  if (node.type !== "file") {
    throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
  }
  if (length === 0) return new Uint8Array();

  // If a write buffer is open for this inode, it is the source of
  // truth: pending writes have not yet committed to vfs_chunks.
  // Reading from SQLite here would return stale bytes.
  const buffered = getWriteBuffer(db, node.inode);
  if (buffered !== undefined && buffered.dirty) {
    if (offset >= buffered.size) return new Uint8Array();
    const end = Math.min(offset + length, buffered.size);
    return buffered.buf.subarray(offset, end);
  }

  // node.size is the cached value resolveInode just loaded.
  const totalSize = node.size;
  if (offset >= totalSize) return new Uint8Array();
  const end = Math.min(offset + length, totalSize);
  const firstIdx = Math.floor(offset / CHUNK_SIZE);
  const lastIdx = Math.floor((end - 1) / CHUNK_SIZE);
  const out = new Uint8Array(end - offset);
  let written = 0;
  for (let idx = firstIdx; idx <= lastIdx; idx++) {
    const start = idx * CHUNK_SIZE;
    const chunk = db.one<{ hash: Uint8Array }>(
      "SELECT hash FROM vfs_chunks WHERE inode = ? AND idx = ?",
      node.inode,
      idx,
    );
    if (chunk === undefined) continue;
    const row = db.one<{ bytes: Uint8Array }>(
      "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
      chunk.hash,
    );
    if (row === undefined) {
      throw createWorkspaceError("EIO", `missing blob bytes for ${path}`, path);
    }
    const srcStart = Math.max(0, offset - start);
    const srcEnd = Math.min(row.bytes.byteLength, end - start);
    if (srcEnd <= srcStart) continue;
    out.set(row.bytes.subarray(srcStart, srcEnd), written);
    written += srcEnd - srcStart;
  }
  return written === out.byteLength ? out : out.subarray(0, written);
}

function touchBlobs(db: Database, chunks: ChunkRow[], at: number): void {
  // Dedupe in case the same chunk hash appears multiple times in a
  // single file — keeps the UPDATE count low without changing semantics.
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const key = bufferKey(chunk.hash);
    if (seen.has(key)) continue;
    seen.add(key);
    db.run("UPDATE vfs_blobs SET last_seen = ? WHERE hash = ?", at, chunk.hash);
  }
}

function bufferKey(bytes: Uint8Array): string {
  // crypto digests are 32 bytes; this is fine.
  let key = "";
  for (const byte of bytes) {
    key += byte.toString(16).padStart(2, "0");
  }
  return key;
}
