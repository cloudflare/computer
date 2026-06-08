import { createHash } from "node:crypto";
import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";
import { stageBlob } from "../sync/blobs.js";
import { buildManifest } from "../sync/manifests.js";
import { assertNotReadOnly } from "./mount-guard.js";

// Fixed chunk size. Exported so tests can size inputs precisely
// without hard-coding the magic number twice.
export const CHUNK_SIZE = 512 * 1024;
export const INLINE_FILE_MAX_BYTES = 16 * 1024;

export type WriteFileContent = string | Uint8Array | ReadableStream<Uint8Array>;

export interface WriteFileOptions {
  mode?: number;
}

export interface WriteFileRange {
  start: number;
  end: number;
}

// Resolve directory-only paths (the parent of the target file). The
// final segment is handled by the caller. Returns the parent inode or
// throws ENOENT/ENOTDIR.
function resolveParent(db: Database, parts: string[], canonical: string): number {
  let parentInode = ROOT_INODE;
  for (let i = 0; i < parts.length - 1; i++) {
    const name = parts[i];
    const child = db.one<{ child_inode: number }>(
      "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
      parentInode,
      name,
    );
    if (child === undefined) {
      throw createWorkspaceError("ENOENT", `parent directory missing: ${canonical}`, canonical);
    }
    const next = db.one<{ inode: number; type: "file" | "dir" }>(
      "SELECT inode, type FROM vfs_nodes WHERE inode = ?",
      child.child_inode,
    );
    if (next === undefined) {
      throw createWorkspaceError("ENOENT", `dangling dirent: ${canonical}`, canonical);
    }
    if (next.type !== "dir") {
      throw createWorkspaceError(
        "ENOTDIR",
        `parent path segment is not a directory: ${canonical}`,
        canonical,
      );
    }
    parentInode = next.inode;
  }
  return parentInode;
}

async function materialize(content: string | Uint8Array): Promise<Uint8Array> {
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }
  return content;
}

// sha256 with a synchronous code path so writeFile can be called both
// from async drivers (the FS API) and from sync drivers (the
// VirtualProvider). node:crypto is available natively on Node and
// polyfilled by workerd.
function sha256(bytes: Uint8Array): Uint8Array {
  const hash = createHash("sha256");
  hash.update(bytes);
  return new Uint8Array(hash.digest());
}

interface PreparedChunk {
  hash: Uint8Array;
  bytes: Uint8Array;
  size: number;
}

interface ChunkRef {
  hash: Uint8Array;
  size: number;
}

export function chunksOf(bytes: Uint8Array): PreparedChunk[] {
  const chunks: PreparedChunk[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, bytes.byteLength);
    // subarray (not slice) avoids an extra copy; sha256() takes its own
    // copy when needed.
    const slice = bytes.subarray(offset, end);
    const hash = sha256(slice);
    chunks.push({ hash, bytes: slice, size: slice.byteLength });
  }
  return chunks;
}

export async function writeFile(
  db: Database,
  path: string,
  content: WriteFileContent,
  options: WriteFileOptions,
  now: () => number,
): Promise<void> {
  if (content instanceof ReadableStream) {
    await writeFileStreaming(db, path, content, options, now);
    return;
  }
  const bytes = await materialize(content);
  writeFileSync(db, path, bytes, options, now, false);
}

// Streaming write path. Reads the source one source-chunk at a time,
// re-windows into fixed CHUNK_SIZE pieces, hashes each window, and
// stages it into vfs_blobs / vfs_blob_bytes as it goes. The final
// inode / dirent / vfs_chunks / manifest writes happen in a single
// short transaction once the source is drained, against a list of
// {hash, size} entries that's O(file_size / CHUNK_SIZE) bytes — not
// O(file_size).
//
// Failure mid-stream leaves blob rows behind; gc() reaps orphans on
// its next pass since no node references them.
async function writeFileStreaming(
  db: Database,
  path: string,
  source: ReadableStream<Uint8Array>,
  options: WriteFileOptions,
  now: () => number,
): Promise<void> {
  const { parts, path: canonical } = canonicalizePath(path);
  if (parts.length === 0) {
    throw createWorkspaceError("EISDIR", "cannot write to the root directory", canonical);
  }
  // Reject before we stage any blob bytes so a read-only mount
  // doesn't grow orphan vfs_blobs rows that gc() then has to reap.
  assertNotReadOnly(db, canonical);
  const mode = (options.mode ?? 0o644) & 0o7777;
  const mtime = now();

  const chunkRefs: Array<{ hash: Uint8Array; size: number }> = [];
  // Carry-over buffer: bytes left over from the previous source chunk
  // that didn't fill a CHUNK_SIZE window.
  let carry: Uint8Array | undefined;

  const flush = (chunk: Uint8Array): void => {
    const hash = sha256(chunk);
    stageBlob(db, hash, chunk, mtime);
    chunkRefs.push({ hash, size: chunk.byteLength });
  };

  const reader = source.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      let input = value;
      if (carry !== undefined) {
        // Splice carry-over onto the front of this source chunk so
        // we can re-window cleanly.
        const merged = new Uint8Array(carry.byteLength + input.byteLength);
        merged.set(carry, 0);
        merged.set(input, carry.byteLength);
        input = merged;
        carry = undefined;
      }
      let offset = 0;
      while (input.byteLength - offset >= CHUNK_SIZE) {
        // Copy the window so the staged blob doesn't alias a
        // larger backing buffer.
        const window = input.slice(offset, offset + CHUNK_SIZE);
        flush(window);
        offset += CHUNK_SIZE;
      }
      if (offset < input.byteLength) {
        carry = input.slice(offset);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (carry !== undefined && carry.byteLength > 0) {
    flush(carry);
  }

  // Wire up the inode against the staged blobs in one short
  // transaction. From this point on the SQL is the same shape as the
  // synchronous path — only the chunk-bytes step is skipped because
  // stageBlob already landed them above.
  db.transactionSync(() => {
    const parentInode = resolveParent(db, parts, canonical);
    const leafName = parts[parts.length - 1];
    const existing = db.one<{ child_inode: number }>(
      "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
      parentInode,
      leafName,
    );
    let inode: number;
    if (existing !== undefined) {
      const node = db.one<{ type: "file" | "dir" }>(
        "SELECT type FROM vfs_nodes WHERE inode = ?",
        existing.child_inode,
      );
      if (node?.type === "dir") {
        throw createWorkspaceError("EISDIR", `path is a directory: ${canonical}`, canonical);
      }
      inode = existing.child_inode;
      db.run("DELETE FROM vfs_chunks WHERE inode = ?", inode);
    } else {
      db.run(
        "INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('file', ?, ?, 0)",
        mode,
        mtime,
      );
      const allocated = db.scalar<number>("SELECT last_insert_rowid()");
      if (allocated === undefined) {
        throw createWorkspaceError("EIO", "failed to allocate inode");
      }
      inode = allocated;
      db.run(
        "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
        parentInode,
        leafName,
        inode,
      );
    }
    for (let idx = 0; idx < chunkRefs.length; idx++) {
      const ref = chunkRefs[idx];
      db.run(
        "INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
        inode,
        idx,
        ref.hash,
        ref.size,
      );
    }
    const manifestHash = buildManifest(db, chunkRefs, mtime);
    const rev = incrementRev(db);
    db.run(
      "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, manifest_hash = ? WHERE inode = ?",
      mode,
      mtime,
      rev,
      manifestHash,
      inode,
    );
  });
}

function upsertChunkBlob(db: Database, chunk: PreparedChunk, lastSeen: number): void {
  db.run(
    "INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET last_seen = excluded.last_seen",
    chunk.hash,
    chunk.size,
    lastSeen,
  );
  db.run(
    "INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING",
    chunk.hash,
    chunk.bytes,
  );
}

function replaceChunkRows(
  db: Database,
  inode: number,
  chunks: ChunkRef[],
  manifestTime: number,
): Uint8Array {
  db.run("DELETE FROM vfs_chunks WHERE inode = ?", inode);
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    db.run(
      "INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
      inode,
      idx,
      chunk.hash,
      chunk.size,
    );
  }
  return buildManifest(db, chunks, manifestTime);
}

function rangesOverlap(start: number, end: number, ranges: WriteFileRange[]): boolean {
  for (const range of ranges) {
    if (range.start < end && start < range.end) return true;
  }
  return false;
}

function normalizeRanges(ranges: WriteFileRange[], size: number): WriteFileRange[] {
  const normalized = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(size, Math.floor(range.start))),
      end: Math.max(0, Math.min(size, Math.ceil(range.end))),
    }))
    .filter((range) => range.start < range.end)
    .sort((a, b) => a.start - b.start);

  const merged: WriteFileRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous === undefined || previous.end < range.start) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

function existingChunkRefs(db: Database, inode: number): ChunkRef[] {
  return db.all<ChunkRef>("SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx", inode);
}

// Synchronous entry point used by the VirtualProvider. Identical SQL
// to the async path; differs only in that the bytes have already been
// materialized.
export function writeFileSync(
  db: Database,
  path: string,
  bytes: Uint8Array,
  options: WriteFileOptions,
  now: () => number,
  inlineAllowed = true,
): void {
  const { parts, path: canonical } = canonicalizePath(path);
  if (parts.length === 0) {
    throw createWorkspaceError("EISDIR", "cannot write to the root directory", canonical);
  }
  assertNotReadOnly(db, canonical);
  const mode = (options.mode ?? 0o644) & 0o7777;
  const mtime = now();
  const inline = inlineAllowed && bytes.byteLength <= INLINE_FILE_MAX_BYTES;

  db.transactionSync(() => {
    const parentInode = resolveParent(db, parts, canonical);
    const leafName = parts[parts.length - 1];
    const existing = db.one<{ child_inode: number }>(
      "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
      parentInode,
      leafName,
    );

    let inode: number;
    if (existing !== undefined) {
      const node = db.one<{ type: "file" | "dir" }>(
        "SELECT type FROM vfs_nodes WHERE inode = ?",
        existing.child_inode,
      );
      if (node?.type === "dir") {
        throw createWorkspaceError("EISDIR", `path is a directory: ${canonical}`, canonical);
      }
      inode = existing.child_inode;
      // Replace the existing representation. Orphaned blobs (if any)
      // are cleaned up by a later gc() pass.
      db.run("DELETE FROM vfs_chunks WHERE inode = ?", inode);
    } else {
      db.run(
        "INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('file', ?, ?, 0)",
        mode,
        mtime,
      );
      const allocated = db.scalar<number>("SELECT last_insert_rowid()");
      if (allocated === undefined) {
        throw createWorkspaceError("EIO", "failed to allocate inode");
      }
      inode = allocated;
      db.run(
        "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
        parentInode,
        leafName,
        inode,
      );
    }

    const rev = incrementRev(db);
    if (inline) {
      db.run(
        "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, manifest_hash = NULL, inline_data = ? WHERE inode = ?",
        mode,
        mtime,
        rev,
        bytes,
        inode,
      );
      return;
    }

    const chunks = chunksOf(bytes);
    // Upsert blobs and write the new chunk list.
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx];
      upsertChunkBlob(db, chunk, mtime);
      db.run(
        "INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
        inode,
        idx,
        chunk.hash,
        chunk.size,
      );
    }

    const manifestHash = buildManifest(db, chunks, mtime);
    db.run(
      "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, manifest_hash = ?, inline_data = NULL WHERE inode = ?",
      mode,
      mtime,
      rev,
      manifestHash,
      inode,
    );
  });
}

export function writeFileRangesSync(
  db: Database,
  path: string,
  bytes: Uint8Array,
  dirtyRanges: WriteFileRange[],
  options: WriteFileOptions,
  now: () => number,
): void {
  const { parts, path: canonical } = canonicalizePath(path);
  if (parts.length === 0) {
    throw createWorkspaceError("EISDIR", "cannot write to the root directory", canonical);
  }
  assertNotReadOnly(db, canonical);
  const mode = (options.mode ?? 0o644) & 0o7777;
  const ranges = normalizeRanges(dirtyRanges, bytes.byteLength);
  const mtime = now();
  const inline = bytes.byteLength <= INLINE_FILE_MAX_BYTES;

  db.transactionSync(() => {
    const parentInode = resolveParent(db, parts, canonical);
    const leafName = parts[parts.length - 1];
    const existing = db.one<{ child_inode: number }>(
      "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
      parentInode,
      leafName,
    );

    let inode: number;
    let oldChunks: ChunkRef[] = [];
    if (existing !== undefined) {
      const node = db.one<{ type: "file" | "dir" }>(
        "SELECT type FROM vfs_nodes WHERE inode = ?",
        existing.child_inode,
      );
      if (node?.type === "dir") {
        throw createWorkspaceError("EISDIR", `path is a directory: ${canonical}`, canonical);
      }
      inode = existing.child_inode;
      oldChunks = existingChunkRefs(db, inode);
    } else {
      db.run(
        "INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('file', ?, ?, 0)",
        mode,
        mtime,
      );
      const allocated = db.scalar<number>("SELECT last_insert_rowid()");
      if (allocated === undefined) {
        throw createWorkspaceError("EIO", "failed to allocate inode");
      }
      inode = allocated;
      db.run(
        "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
        parentInode,
        leafName,
        inode,
      );
    }

    const rev = incrementRev(db);
    if (inline) {
      db.run("DELETE FROM vfs_chunks WHERE inode = ?", inode);
      db.run(
        "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, manifest_hash = NULL, inline_data = ? WHERE inode = ?",
        mode,
        mtime,
        rev,
        bytes,
        inode,
      );
      return;
    }

    const nextChunks: ChunkRef[] = [];
    const chunkCount = Math.ceil(bytes.byteLength / CHUNK_SIZE);
    for (let idx = 0; idx < chunkCount; idx++) {
      const start = idx * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, bytes.byteLength);
      const size = end - start;
      const oldChunk = oldChunks[idx];
      if (oldChunk !== undefined && oldChunk.size === size && !rangesOverlap(start, end, ranges)) {
        nextChunks.push(oldChunk);
        continue;
      }
      const chunk = {
        hash: sha256(bytes.subarray(start, end)),
        bytes: bytes.subarray(start, end),
        size,
      };
      upsertChunkBlob(db, chunk, mtime);
      nextChunks.push({ hash: chunk.hash, size: chunk.size });
    }

    const manifestHash = replaceChunkRows(db, inode, nextChunks, mtime);
    db.run(
      "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, manifest_hash = ?, inline_data = NULL WHERE inode = ?",
      mode,
      mtime,
      rev,
      manifestHash,
      inode,
    );
  });
}
