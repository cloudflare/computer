import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";
import { getBlobBytes } from "./blobCache.js";
import { findPendingWriteBuffer } from "./pendingWriteBuffer.js";
import { resolveInode } from "./resolve.js";
import { getWriteBuffer } from "./writeBuffer.js";
import { CHUNK_SIZE } from "./writeFile.js";

export interface ReadFileOptions {
  encoding?: "utf8";
  /** First byte to return. Defaults to 0. */
  byteOffset?: number;
  /** Maximum bytes to return. Defaults to the rest of the file. */
  byteLength?: number;
}

type BinaryReadFileOptions = ReadFileOptions & { encoding?: undefined };
type TextReadFileOptions = ReadFileOptions & { encoding: "utf8" };

interface ChunkRow {
  idx: number;
  hash: Uint8Array;
  size: number;
}

// Overloads match docs/04_filesystem_interface.md exactly.
export function readFile(db: Database, path: string): Promise<ReadableStream<Uint8Array>>;
export function readFile(db: Database, path: string, encoding: "utf8"): Promise<string>;
export function readFile(
  db: Database,
  path: string,
  options: BinaryReadFileOptions,
): Promise<ReadableStream<Uint8Array>>;
export function readFile(db: Database, path: string, options: TextReadFileOptions): Promise<string>;
export function readFile(
  db: Database,
  path: string,
  options: ReadFileOptions,
): Promise<string | ReadableStream<Uint8Array>>;
export async function readFile(
  db: Database,
  path: string,
  optionsOrEncoding?: "utf8" | ReadFileOptions,
): Promise<string | ReadableStream<Uint8Array>> {
  const options = typeof optionsOrEncoding === "object" ? optionsOrEncoding : undefined;
  const wantString =
    optionsOrEncoding === "utf8" || (options !== undefined && options.encoding === "utf8");
  const byteOffset = options?.byteOffset ?? 0;
  const byteLength = options?.byteLength;
  validateReadWindow(path, byteOffset, byteLength);

  // Pending-create files surface through the path-keyed buffer. Copy only the
  // requested window so the returned stream remains a snapshot while writes
  // continue through the open buffer.
  const { path: canonical } = canonicalizePath(path);
  const pending = findPendingWriteBuffer(db, canonical);
  if (pending !== undefined) {
    return snapshotResult(pending.buf, pending.size, byteOffset, byteLength, wantString);
  }

  // Resolve up front so we surface ENOENT/EISDIR before doing any
  // streaming work.
  const node = resolveInode(db, path);
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
  }
  if (node.type !== "file") {
    throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
  }

  // While a write buffer is open for this inode it is the source of truth.
  // Snapshot only the selected bytes instead of touching the chunk store.
  const buffered = getWriteBuffer(db, node.inode);
  if (buffered?.dirty) {
    return snapshotResult(buffered.buf, buffered.size, byteOffset, byteLength, wantString);
  }

  const { start, end, length } = readWindow(node.size, byteOffset, byteLength);
  const firstIdx = length === 0 ? 0 : Math.floor(start / CHUNK_SIZE);
  const lastIdx = length === 0 ? -1 : Math.floor((end - 1) / CHUNK_SIZE);
  const chunks =
    length === 0
      ? []
      : db.all<ChunkRow>(
          `SELECT idx, hash, size
             FROM vfs_chunks
            WHERE inode = ? AND idx BETWEEN ? AND ?
            ORDER BY idx`,
          node.inode,
          firstIdx,
          lastIdx,
        );
  assertDenseRange(chunks, firstIdx, lastIdx, path);

  if (wantString) {
    // String reads intentionally materialize the selected range so it can be
    // decoded once. Binary callers receive the lazy stream below.
    const out = new Uint8Array(length);
    let written = 0;
    for (const chunk of chunks) {
      const bytes = rangedChunkBytes(db, path, chunk, start, end);
      out.set(bytes, written);
      written += bytes.byteLength;
    }
    return new TextDecoder().decode(out);
  }

  // The row list is captured once when the stream opens. Blob hashes are
  // immutable, so later writes cannot tear the returned range. Pulling stays
  // lazy and preserves backpressure across the RPC stream.
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index++];
      controller.enqueue(rangedChunkBytes(db, path, chunk, start, end));
    },
  });
}

function validateReadWindow(
  path: string,
  byteOffset: number,
  byteLength: number | undefined,
): void {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw createWorkspaceError("EINVAL", `invalid read offset: ${byteOffset}`, path);
  }
  if (byteLength !== undefined && (!Number.isSafeInteger(byteLength) || byteLength < 0)) {
    throw createWorkspaceError("EINVAL", `invalid read length: ${byteLength}`, path);
  }
}

function readWindow(
  size: number,
  byteOffset: number,
  byteLength: number | undefined,
): { start: number; end: number; length: number } {
  const start = Math.min(byteOffset, size);
  const available = size - start;
  const length = byteLength === undefined ? available : Math.min(available, byteLength);
  return { start, end: start + length, length };
}

function snapshotResult(
  source: Uint8Array,
  size: number,
  byteOffset: number,
  byteLength: number | undefined,
  wantString: boolean,
): string | ReadableStream<Uint8Array> {
  const { start, end } = readWindow(size, byteOffset, byteLength);
  const snapshot = source.slice(start, end);
  if (wantString) return new TextDecoder().decode(snapshot);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (snapshot.byteLength > 0) controller.enqueue(snapshot);
      controller.close();
    },
  });
}

function assertDenseRange(
  chunks: Array<Pick<ChunkRow, "idx">>,
  firstIdx: number,
  lastIdx: number,
  path: string,
): void {
  for (let idx = firstIdx; idx <= lastIdx; idx += 1) {
    if (chunks[idx - firstIdx]?.idx !== idx) {
      throw createWorkspaceError("EIO", `missing chunk data for ${path}`, path);
    }
  }
}

function rangedChunkBytes(
  db: Database,
  path: string,
  chunk: ChunkRow,
  start: number,
  end: number,
): Uint8Array {
  const bytes = getBlobBytes(db, chunk.hash);
  if (bytes === undefined) {
    throw createWorkspaceError("EIO", `missing blob bytes for ${path}`, path);
  }
  const chunkStart = chunk.idx * CHUNK_SIZE;
  const from = Math.max(0, start - chunkStart);
  const to = Math.min(bytes.byteLength, end - chunkStart);
  return bytes.subarray(from, to);
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
  // Pending-create files have no inode yet. Serve reads from the
  // path-keyed buffer until release commits the row.
  const { path: canonical } = canonicalizePath(path);
  const pending = findPendingWriteBuffer(db, canonical);
  if (pending !== undefined) {
    if (length === 0) return new Uint8Array();
    if (offset >= pending.size) return new Uint8Array();
    const end = Math.min(offset + length, pending.size);
    return pending.buf.slice(offset, end);
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
  if (buffered?.dirty) {
    if (offset >= buffered.size) return new Uint8Array();
    const end = Math.min(offset + length, buffered.size);
    return buffered.buf.slice(offset, end);
  }

  // node.size is the cached value resolveInode just loaded.
  const totalSize = node.size;
  if (offset >= totalSize) return new Uint8Array();
  const end = Math.min(offset + length, totalSize);
  const firstIdx = Math.floor(offset / CHUNK_SIZE);
  const lastIdx = Math.floor((end - 1) / CHUNK_SIZE);
  // Pull every overlapping chunk in one indexed range scan. Files are
  // represented densely; a missing row indicates corrupt storage.
  const chunks = db.all<{ idx: number; hash: Uint8Array }>(
    "SELECT idx, hash FROM vfs_chunks WHERE inode = ? AND idx BETWEEN ? AND ? ORDER BY idx",
    node.inode,
    firstIdx,
    lastIdx,
  );
  assertDenseRange(chunks, firstIdx, lastIdx, path);
  const out = new Uint8Array(end - offset);
  let written = 0;
  for (const { idx, hash } of chunks) {
    const start = idx * CHUNK_SIZE;
    const bytes = getBlobBytes(db, hash);
    if (bytes === undefined) {
      throw createWorkspaceError("EIO", `missing blob bytes for ${path}`, path);
    }
    const srcStart = Math.max(0, offset - start);
    const srcEnd = Math.min(bytes.byteLength, end - start);
    if (srcEnd <= srcStart) continue;
    out.set(bytes.subarray(srcStart, srcEnd), written);
    written += srcEnd - srcStart;
  }
  if (written !== out.byteLength) {
    throw createWorkspaceError("EIO", `incomplete chunk data for ${path}`, path);
  }
  return out;
}
