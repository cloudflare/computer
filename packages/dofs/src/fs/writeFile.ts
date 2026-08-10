import { createHash } from "node:crypto";
import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";
import { stageBlob } from "../sync/blobs.js";
import { buildManifest } from "../sync/manifests.js";
import { getBlobBytes } from "./blobCache.js";
import { assertNotReadOnly } from "./mount-guard.js";
import { resolveInode } from "./resolve.js";
import { invalidateResolveExact } from "./resolveCache.js";
import {
  allocatePendingInode,
  deleteWriteBuffer,
  ensureCapacity as ensureBufferCapacity,
  getPendingWriteBufferByPath,
  getWriteBuffer,
  promotePendingToInode,
  setWriteBuffer,
  type WriteBufferEntry,
} from "./writeBuffer.js";

// Fixed chunk size. Exported so tests can size inputs precisely
// without hard-coding the magic number twice.
export const CHUNK_SIZE = 512 * 1024;

export type WriteFileContent = string | Uint8Array | ReadableStream<Uint8Array>;

export interface WriteFileOptions {
  mode?: number;
  /** Fail with EEXIST when the target already exists. */
  exclusive?: boolean;
}

export interface WriteFileRange {
  start: number;
  end: number;
}

// Resolve directory-only paths (the parent of the target file). The
// final segment is handled by the caller. Returns the parent inode or
// throws ENOENT/ENOTDIR. Intermediate symlinks are followed by the
// normal resolver so writes match read/path-resolution semantics.
function resolveParent(db: Database, parts: string[], canonical: string): number {
  if (parts.length === 1) return ROOT_INODE;

  const parentPath = `/${parts.slice(0, -1).join("/")}`;
  const parent = resolveInode(db, parentPath);
  if (parent === null) {
    throw createWorkspaceError("ENOENT", `parent directory missing: ${canonical}`, canonical);
  }
  if (parent.type !== "dir") {
    throw createWorkspaceError(
      "ENOTDIR",
      `parent path segment is not a directory: ${canonical}`,
      canonical,
    );
  }
  return parent.inode;
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

type WriteTarget =
  | { kind: "existing"; inode: number }
  | { kind: "create"; parentInode: number; leafName: string; canonicalPath: string };

function pathFromParts(parts: string[]): string {
  return `/${parts.join("/")}`;
}

function symlinkTargetPath(target: string, linkParentParts: string[]): string {
  if (target.startsWith("/")) return canonicalizePath(target).path;

  const resolved = [...linkParentParts];
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return pathFromParts(resolved);
}

function resolveWriteTarget(
  db: Database,
  parts: string[],
  canonical: string,
  options: WriteFileOptions,
): WriteTarget {
  const parentInode = resolveParent(db, parts, canonical);
  const leafName = parts[parts.length - 1];
  const existing = db.one<{ child_inode: number }>(
    "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
    parentInode,
    leafName,
  );

  if (existing === undefined) {
    return { kind: "create", parentInode, leafName, canonicalPath: canonical };
  }
  if (options.exclusive) {
    throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
  }

  const node = db.one<{ type: "file" | "dir" | "symlink"; link_target: string | null }>(
    "SELECT type, link_target FROM vfs_nodes WHERE inode = ?",
    existing.child_inode,
  );
  if (node?.type === "dir") {
    throw createWorkspaceError("EISDIR", `path is a directory: ${canonical}`, canonical);
  }
  if (node?.type !== "symlink") {
    return { kind: "existing", inode: existing.child_inode };
  }

  const targetPath = symlinkTargetPath(node.link_target ?? "", parts.slice(0, -1));
  assertNotReadOnly(db, targetPath);
  const target = resolveInode(db, targetPath);
  if (target === null) {
    const { parts: targetParts, path: targetCanonical } = canonicalizePath(targetPath);
    if (targetParts.length === 0) {
      throw createWorkspaceError("EISDIR", "cannot write to the root directory", targetCanonical);
    }
    return {
      kind: "create",
      parentInode: resolveParent(db, targetParts, targetCanonical),
      leafName: targetParts[targetParts.length - 1],
      canonicalPath: targetCanonical,
    };
  }
  if (target.type !== "file") {
    throw createWorkspaceError("EISDIR", `path is a directory: ${targetPath}`, targetPath);
  }
  return { kind: "existing", inode: target.inode };
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
  writeFileSync(db, path, bytes, options, now);
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
  // Reject before we stage any blob bytes so known failures do not grow
  // orphan blob rows that gc() then has to reap.
  assertNotReadOnly(db, canonical);
  if (options.exclusive) {
    const parentInode = resolveParent(db, parts, canonical);
    const existing = db.one(
      "SELECT 1 FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
      parentInode,
      parts[parts.length - 1],
    );
    if (existing !== undefined) {
      throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
    }
  }
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

  linkStagedChunksSync(db, canonical, parts, chunkRefs, { ...options, mode }, mtime);
}

// Reject a chunk list that positional reads could not address.
// readRangeSync finds the chunk covering an offset by dividing that
// offset by CHUNK_SIZE, and takes a chunk's start offset to be its
// index times CHUNK_SIZE, so every chunk but the last has to fill a
// whole window and none may overflow one. Local writers chunk with
// chunksOf and satisfy this by construction; a chunk list that
// arrived over sync does not have to.
export function assertChunkWindows(chunkRefs: ChunkRef[], canonical: string): void {
  for (let idx = 0; idx < chunkRefs.length; idx++) {
    const { size } = chunkRefs[idx];
    const last = idx === chunkRefs.length - 1;
    if (size === CHUNK_SIZE || (last && size < CHUNK_SIZE)) continue;
    throw createWorkspaceError(
      "EINVAL",
      `chunk ${idx} of ${chunkRefs.length} holds ${size} bytes; only the last chunk may be shorter than ${CHUNK_SIZE}: ${canonical}`,
      canonical,
    );
  }
}

// Link a path to chunks already staged in content-addressed storage.
// This keeps payload bytes out of memory during sync apply.
//
// The chunk list comes from a caller that did its own chunking, so
// the guards every other write path gets from writeFile have to run
// here too: the read-only mount check, and the fixed-window layout
// that positional reads depend on.
export function linkStagedChunksSync(
  db: Database,
  canonical: string,
  parts: string[],
  chunkRefs: { hash: Uint8Array; size: number }[],
  options: WriteFileOptions,
  mtime: number,
): void {
  assertNotReadOnly(db, canonical);
  assertChunkWindows(chunkRefs, canonical);
  const mode = (options.mode ?? 0o644) & 0o7777;
  db.transactionSync(() => {
    const target = resolveWriteTarget(db, parts, canonical, options);
    const inode = target.kind === "existing" ? target.inode : insertFileNode(db, mode, mtime);
    if (target.kind === "existing") {
      db.run("DELETE FROM vfs_chunks WHERE inode = ?", inode);
    } else {
      insertFileDirent(db, target.parentInode, target.leafName, inode, target.canonicalPath);
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
    // Referenced chunks cannot be collected, so last_seen only protects
    // blobs during the staging window before this transaction.
    const manifestHash = buildManifest(db, chunkRefs, mtime);
    const rev = incrementRev(db);
    let totalSize = 0;
    for (const ref of chunkRefs) totalSize += ref.size;
    db.run(
      "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, size = ?, manifest_hash = ? WHERE inode = ?",
      mode,
      mtime,
      rev,
      totalSize,
      manifestHash,
      inode,
    );
  });
}

// Allocate a fresh file inode row with the supplied mode and mtime,
// using SQLite's RETURNING so the new rowid comes back in the same
// statement instead of through a follow-up SELECT last_insert_rowid().
// Link a freshly created file inode into its parent directory and drop
// any cached negative resolution for the new path. The single choke
// point for every new-file dirent, so the resolve cache stays correct
// on create without touching the overwrite path (which reuses the
// existing inode and dirent, so its resolution is unchanged). A new
// file is a leaf with no descendants, so exact invalidation suffices.
function insertFileDirent(
  db: Database,
  parentInode: number,
  leafName: string,
  childInode: number,
  canonicalPath: string,
): void {
  db.run(
    "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
    parentInode,
    leafName,
    childInode,
  );
  invalidateResolveExact(db, canonicalPath);
}

function insertFileNode(db: Database, mode: number, mtime: number): number {
  const row = db.one<{ inode: number }>(
    "INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('file', ?, ?, 0) RETURNING inode",
    mode,
    mtime,
  );
  if (row === undefined) {
    throw createWorkspaceError("EIO", "failed to allocate inode");
  }
  return row.inode;
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

function fileSizeForInode(db: Database, inode: number): number {
  return db.scalar<number>("SELECT size FROM vfs_nodes WHERE inode = ?", inode) ?? 0;
}

function readChunkBytes(db: Database, inode: number, idx: number): Uint8Array {
  const chunk = db.one<{ hash: Uint8Array }>(
    "SELECT hash FROM vfs_chunks WHERE inode = ? AND idx = ?",
    inode,
    idx,
  );
  if (chunk === undefined) return new Uint8Array();
  const bytes = getBlobBytes(db, chunk.hash);
  if (bytes === undefined) {
    throw createWorkspaceError("EIO", "missing blob bytes");
  }
  return bytes;
}

function resolveFileInode(db: Database, path: string): { inode: number; mode: number } {
  const { path: canonical } = canonicalizePath(path);
  const node = resolveInode(db, path);
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such file: ${canonical}`, canonical);
  }
  if (node.type !== "file") {
    throw createWorkspaceError("EISDIR", `path is a directory: ${canonical}`, canonical);
  }
  return { inode: node.inode, mode: node.mode };
}

function parentAndNameForResolvedPath(db: Database, path: string): [number, string] {
  const { parts, path: canonical } = canonicalizePath(path);
  if (parts.length === 0) {
    throw createWorkspaceError("EISDIR", "cannot write to the root directory", canonical);
  }
  return [resolveParent(db, parts, canonical), parts[parts.length - 1]];
}

// Update an inode's chunk-backed representation in place. Iterates over
// the full chunk grid but only touches `vfs_chunks` rows whose contents
// or size actually changed, so untouched chunk rows keep their
// rowids and the surrounding rows do not churn. The manifest is
// invalidated rather than recomputed; sync rebuilds it lazily.
function applyChunkedInodeUpdate(
  db: Database,
  inode: number,
  size: number,
  mode: number,
  mtime: number,
  isTouched: (idx: number, start: number, end: number) => boolean,
  buildChunkBytes: (idx: number, start: number, end: number, existing: Uint8Array) => Uint8Array,
): void {
  const oldChunks = existingChunkRefs(db, inode);
  const chunkCount = Math.ceil(size / CHUNK_SIZE);
  const oldChunkCount = oldChunks.length;

  for (let idx = 0; idx < chunkCount; idx++) {
    const start = idx * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, size);
    const intendedSize = end - start;
    const old = oldChunks[idx];
    const touched = isTouched(idx, start, end);
    // Stable chunk: existed before with the same logical size and the
    // caller did not flag it as touched. Skip without issuing SQL so
    // its rowid stays put.
    if (old !== undefined && old.size === intendedSize && !touched) continue;

    const existingBytes = old !== undefined ? readChunkBytes(db, inode, idx) : new Uint8Array();
    const chunkBytes = buildChunkBytes(idx, start, end, existingBytes);
    if (chunkBytes.byteLength !== intendedSize) {
      throw createWorkspaceError("EIO", "chunk builder returned wrong size");
    }
    const chunk = { hash: sha256(chunkBytes), bytes: chunkBytes, size: chunkBytes.byteLength };
    upsertChunkBlob(db, chunk, mtime);
    db.run(
      "INSERT OR REPLACE INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
      inode,
      idx,
      chunk.hash,
      chunk.size,
    );
  }

  // Drop any old chunks past the new end of file (shrink case).
  if (oldChunkCount > chunkCount) {
    db.run("DELETE FROM vfs_chunks WHERE inode = ? AND idx >= ?", inode, chunkCount);
  }

  const rev = incrementRev(db);
  db.run(
    "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, size = ?, manifest_hash = NULL WHERE inode = ?",
    mode,
    mtime,
    rev,
    size,
    inode,
  );
}

export function createFileSync(
  db: Database,
  path: string,
  options: WriteFileOptions,
  now: () => number,
): void {
  const { path: canonical } = canonicalizePath(path);
  assertNotReadOnly(db, canonical);
  const [parentInode, leafName] = parentAndNameForResolvedPath(db, path);
  const mode = (options.mode ?? 0o644) & 0o7777;
  const mtime = now();

  db.transactionSync(() => {
    const existing = db.one<{ child_inode: number }>(
      "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
      parentInode,
      leafName,
    );
    if (existing !== undefined) {
      throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
    }
    const rev = incrementRev(db);
    // INSERT with RETURNING folds the last_insert_rowid lookup into
    // the same statement, and computing rev up front lets us write
    // the node row with its final stamp in one shot.
    const row = db.one<{ inode: number }>(
      "INSERT INTO vfs_nodes (type, mode, mtime, rev, manifest_hash) VALUES ('file', ?, ?, ?, NULL) RETURNING inode",
      mode,
      mtime,
      rev,
    );
    if (row === undefined) throw createWorkspaceError("EIO", "failed to allocate inode");
    insertFileDirent(db, parentInode, leafName, row.inode, canonical);
  });
}

// Open a write buffer for an existing file. Subsequent writes,
// truncates, and reads against the same Database operate on the
// buffer instead of the SQLite chunk/blob store. Release commits
// the bytes back to chunks.
export function openWriteBufferSync(db: Database, path: string): void {
  const { path: canonical } = canonicalizePath(path);
  const pending = getPendingWriteBufferByPath(db, canonical);
  if (pending !== undefined) {
    pending.openCount += 1;
    return;
  }
  const { inode, mode } = resolveFileInode(db, path);
  const existing = getWriteBuffer(db, inode);
  if (existing !== undefined) {
    existing.openCount += 1;
    return;
  }
  setWriteBuffer(db, inode, {
    buf: new Uint8Array(0),
    size: 0,
    dirty: false,
    openCount: 1,
    mode,
  });
}

// Create a new file lazily: stash a pending-create write buffer
// keyed by path, without touching SQL until release. createFileSync
// + openWriteBufferSync + writes + releaseWriteBufferSync would
// otherwise spend two transactions per file (one INSERT round and
// one chunk-commit round); this collapses them into a single
// INSERT-and-chunks transaction at release time.
//
// Throws EEXIST if a path already resolves to a live node or to
// another pending buffer.
export function openWriteBufferForCreateSync(
  db: Database,
  path: string,
  options: WriteFileOptions,
  now: () => number,
): void {
  const { path: canonical } = canonicalizePath(path);
  assertNotReadOnly(db, canonical);
  if (getPendingWriteBufferByPath(db, canonical) !== undefined) {
    throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
  }
  const [parentInode, leafName] = parentAndNameForResolvedPath(db, path);
  const existing = db.one<{ child_inode: number }>(
    "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
    parentInode,
    leafName,
  );
  if (existing !== undefined) {
    throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
  }
  const mode = (options.mode ?? 0o644) & 0o7777;
  const mtime = now();
  const pendingInode = allocatePendingInode(db);
  setWriteBuffer(db, pendingInode, {
    buf: new Uint8Array(0),
    size: 0,
    dirty: true,
    openCount: 1,
    mode,
    pending: { parentInode, leafName, canonicalPath: canonical, pendingInode, mtime },
  });
}

// Release one open of an inode's write buffer. When the open count
// reaches zero, commit the buffered bytes to chunk rows and drop
// the entry. The committed mode is the buffer's mode at release
// time so an intermediate chmod survives. Pending-create entries
// emit their INSERT + dirent + chunks in the same transaction.
export function releaseWriteBufferSync(db: Database, path: string, now: () => number): void {
  const { path: canonical } = canonicalizePath(path);
  const pending = getPendingWriteBufferByPath(db, canonical);
  if (pending !== undefined) {
    releasePendingBuffer(db, pending, now);
    return;
  }
  const node = resolveFileInode(db, path);
  const entry = getWriteBuffer(db, node.inode);
  if (entry === undefined) return;
  entry.openCount -= 1;
  if (entry.openCount > 0) return;

  if (!entry.dirty) {
    deleteWriteBuffer(db, node.inode);
    return;
  }

  const mtime = now();
  const mode = entry.mode & 0o7777;
  const buffered = entry.buf.subarray(0, entry.size);

  db.transactionSync(() => {
    if (entry.size === 0) {
      // An empty file owns no chunk rows; clear any old ones the
      // buffer would otherwise have replaced and bump metadata.
      db.run("DELETE FROM vfs_chunks WHERE inode = ?", node.inode);
      const rev = incrementRev(db);
      db.run(
        "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, size = 0, manifest_hash = NULL WHERE inode = ?",
        mode,
        mtime,
        rev,
        node.inode,
      );
      return;
    }
    applyChunkedInodeUpdate(
      db,
      node.inode,
      entry.size,
      mode,
      mtime,
      (_idx, start, end) => start < entry.size && end > 0,
      (_idx, start, end) => buffered.subarray(start, Math.min(end, entry.size)),
    );
  });

  deleteWriteBuffer(db, node.inode);
}

// Commit a pending-create buffer to SQLite. Returns the real inode
// allocated by the INSERT, or throws. Promotes the cache entry's key
// from the synthetic pending id to the real inode so subsequent
// reads/writes through the inode-keyed cache still see the same
// buffer. Caller owns the lifecycle of the now-promoted entry.
function commitPendingBuffer(db: Database, entry: WriteBufferEntry, now: () => number): number {
  if (entry.pending === undefined) {
    throw createWorkspaceError("EIO", "commitPendingBuffer called on non-pending entry");
  }
  const { parentInode, leafName, canonicalPath, pendingInode } = entry.pending;
  const mtime = now();
  const mode = entry.mode & 0o7777;
  const buffered = entry.buf.subarray(0, entry.size);

  let realInode = 0;
  try {
    db.transactionSync(() => {
      // Re-check at commit time: a non-buffered writeFile or another
      // out-of-band path could have landed between open and release.
      const collision = db.one<{ child_inode: number }>(
        "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
        parentInode,
        leafName,
      );
      if (collision !== undefined) {
        throw createWorkspaceError(
          "EEXIST",
          `path exists at commit time: ${canonicalPath}`,
          canonicalPath,
        );
      }
      const rev = incrementRev(db);
      const row = db.one<{ inode: number }>(
        "INSERT INTO vfs_nodes (type, mode, mtime, rev, size, manifest_hash) VALUES ('file', ?, ?, ?, ?, NULL) RETURNING inode",
        mode,
        mtime,
        rev,
        entry.size,
      );
      if (row === undefined) {
        throw createWorkspaceError("EIO", "failed to allocate inode");
      }
      insertFileDirent(db, parentInode, leafName, row.inode, canonicalPath);
      if (entry.size > 0) {
        const inode = row.inode;
        const chunkCount = Math.ceil(entry.size / CHUNK_SIZE);
        for (let idx = 0; idx < chunkCount; idx++) {
          const start = idx * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, entry.size);
          const chunkBytes = buffered.subarray(start, end);
          const chunk = {
            hash: sha256(chunkBytes),
            bytes: chunkBytes,
            size: chunkBytes.byteLength,
          };
          upsertChunkBlob(db, chunk, mtime);
          db.run(
            "INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
            inode,
            idx,
            chunk.hash,
            chunk.size,
          );
        }
      }
      realInode = row.inode;
    });
  } catch (error) {
    // Transaction rolled back; drop the buffer so the next caller
    // starts clean.
    deleteWriteBuffer(db, pendingInode);
    throw error;
  }
  promotePendingToInode(db, pendingInode, realInode);
  return realInode;
}

/**
 * @internal
 * Bridges a pending-create write buffer into the SQL world ahead of a
 * dirent-mutating provider operation (link, rename, unlink). Leaves
 * the open count untouched so a still-open handle keeps writing into
 * the now-promoted buffer. Returns true when a pending buffer was
 * committed. External callers should never invoke this directly.
 */
export function flushPendingByPath(db: Database, path: string, now: () => number): boolean {
  const { path: canonical } = canonicalizePath(path);
  const entry = getPendingWriteBufferByPath(db, canonical);
  if (entry === undefined || entry.pending === undefined) return false;
  commitPendingBuffer(db, entry, now);
  return true;
}

function releasePendingBuffer(db: Database, entry: WriteBufferEntry, now: () => number): void {
  if (entry.pending === undefined) return;
  entry.openCount -= 1;
  if (entry.openCount > 0) return;

  const inode = commitPendingBuffer(db, entry, now);
  // File is closed; drop the now-promoted entry. A subsequent open
  // hits the SQL path and gets a fresh buffer if needed.
  deleteWriteBuffer(db, inode);
}

// Hydrate a freshly-opened buffer with the inode's current bytes
// the first time we mutate it. Avoids paying the read cost when the
// caller opens a file just to truncate or overwrite it.
function hydrateBufferIfNeeded(db: Database, inode: number, entry: WriteBufferEntry): void {
  if (entry.dirty) return;
  const existingSize = fileSizeForInode(db, inode);
  if (existingSize === 0) {
    entry.dirty = true;
    return;
  }
  ensureBufferCapacity(entry, existingSize);
  let copied = 0;
  for (let idx = 0; copied < existingSize; idx++) {
    const chunk = readChunkBytes(db, inode, idx);
    if (chunk.byteLength === 0) break;
    entry.buf.set(chunk, copied);
    copied += chunk.byteLength;
  }
  entry.size = existingSize;
  entry.dirty = true;
}

export function writeRangeSync(
  db: Database,
  path: string,
  bytes: Uint8Array,
  offset: number,
  options: WriteFileOptions,
  now: () => number,
): number {
  const { path: canonical } = canonicalizePath(path);
  assertNotReadOnly(db, canonical);
  if (!Number.isInteger(offset) || offset < 0) {
    throw createWorkspaceError("EINVAL", `invalid write offset: ${offset}`, canonical);
  }
  if (bytes.byteLength === 0) return 0;
  const mtime = now();

  // Pending-create files don't have an inode yet; route the write
  // straight into the path-keyed buffer.
  const pending = getPendingWriteBufferByPath(db, canonical);
  if (pending !== undefined) {
    const writeEnd = offset + bytes.byteLength;
    ensureBufferCapacity(pending, writeEnd);
    if (offset > pending.size) {
      pending.buf.fill(0, pending.size, offset);
    }
    pending.buf.set(bytes, offset);
    if (writeEnd > pending.size) pending.size = writeEnd;
    pending.mode = (options.mode ?? pending.mode) & 0o7777;
    pending.dirty = true;
    return bytes.byteLength;
  }

  const { inode, mode: existingMode } = resolveFileInode(db, path);
  const mode = (options.mode ?? existingMode) & 0o7777;
  const buffered = getWriteBuffer(db, inode);

  // Buffered path: mutate the in-memory bytes and defer storage
  // writes until release. Reads through the same Database see the
  // buffer's current bytes via readRangeSync's buffer check.
  if (buffered !== undefined) {
    hydrateBufferIfNeeded(db, inode, buffered);
    const writeEnd = offset + bytes.byteLength;
    ensureBufferCapacity(buffered, writeEnd);
    if (offset > buffered.size) {
      buffered.buf.fill(0, buffered.size, offset);
    }
    buffered.buf.set(bytes, offset);
    if (writeEnd > buffered.size) buffered.size = writeEnd;
    buffered.mode = mode;
    buffered.dirty = true;
    return bytes.byteLength;
  }

  db.transactionSync(() => {
    const oldSize = fileSizeForInode(db, inode);
    const writeEnd = offset + bytes.byteLength;
    const nextSize = Math.max(oldSize, writeEnd);

    applyChunkedInodeUpdate(
      db,
      inode,
      nextSize,
      mode,
      mtime,
      (_idx, start, end) => offset < end && start < writeEnd,
      (_idx, start, end, existing) => {
        const chunkBytes = new Uint8Array(end - start);
        chunkBytes.set(existing.subarray(0, Math.min(existing.byteLength, chunkBytes.byteLength)));
        if (offset < end && start < writeEnd) {
          const copyStart = Math.max(start, offset);
          const copyEnd = Math.min(end, writeEnd);
          chunkBytes.set(bytes.subarray(copyStart - offset, copyEnd - offset), copyStart - start);
        }
        return chunkBytes;
      },
    );
  });

  return bytes.byteLength;
}

export function truncateFileSync(
  db: Database,
  path: string,
  size: number,
  now: () => number,
): void {
  const { path: canonical } = canonicalizePath(path);
  assertNotReadOnly(db, canonical);
  if (!Number.isInteger(size) || size < 0) {
    throw createWorkspaceError("EINVAL", `invalid truncate size: ${size}`, canonical);
  }
  const mtime = now();

  // Pending-create files truncate in-place on the path-keyed buffer.
  const pending = getPendingWriteBufferByPath(db, canonical);
  if (pending !== undefined) {
    if (size > pending.size) {
      ensureBufferCapacity(pending, size);
      pending.buf.fill(0, pending.size, size);
    }
    pending.size = size;
    pending.dirty = true;
    return;
  }

  const { inode, mode } = resolveFileInode(db, path);
  const buffered = getWriteBuffer(db, inode);

  if (buffered !== undefined) {
    hydrateBufferIfNeeded(db, inode, buffered);
    if (size > buffered.size) {
      ensureBufferCapacity(buffered, size);
      buffered.buf.fill(0, buffered.size, size);
    }
    buffered.size = size;
    buffered.dirty = true;
    return;
  }

  db.transactionSync(() => {
    const oldSize = fileSizeForInode(db, inode);
    if (oldSize === size) return;

    if (size === 0) {
      db.run("DELETE FROM vfs_chunks WHERE inode = ?", inode);
      const rev = incrementRev(db);
      db.run(
        "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, size = 0, manifest_hash = NULL WHERE inode = ?",
        mode,
        mtime,
        rev,
        inode,
      );
      return;
    }

    applyChunkedInodeUpdate(
      db,
      inode,
      size,
      mode,
      mtime,
      () => false,
      (_idx, start, end, existing) => {
        const chunkBytes = new Uint8Array(end - start);
        chunkBytes.set(existing.subarray(0, Math.min(existing.byteLength, chunkBytes.byteLength)));
        return chunkBytes;
      },
    );
  });
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
): void {
  const { parts, path: canonical } = canonicalizePath(path);
  if (parts.length === 0) {
    throw createWorkspaceError("EISDIR", "cannot write to the root directory", canonical);
  }
  assertNotReadOnly(db, canonical);
  const mode = (options.mode ?? 0o644) & 0o7777;
  const mtime = now();

  db.transactionSync(() => {
    const target = resolveWriteTarget(db, parts, canonical, options);
    const inode = target.kind === "existing" ? target.inode : insertFileNode(db, mode, mtime);
    if (target.kind === "existing") {
      // Replace the existing representation. Orphaned blobs (if any)
      // are cleaned up by a later gc() pass.
      db.run("DELETE FROM vfs_chunks WHERE inode = ?", inode);
    } else {
      insertFileDirent(db, target.parentInode, target.leafName, inode, target.canonicalPath);
    }

    const rev = incrementRev(db);
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
      "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, size = ?, manifest_hash = ? WHERE inode = ?",
      mode,
      mtime,
      rev,
      bytes.byteLength,
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
  db.transactionSync(() => {
    const target = resolveWriteTarget(db, parts, canonical, options);
    const inode = target.kind === "existing" ? target.inode : insertFileNode(db, mode, mtime);
    let oldChunks: ChunkRef[] = [];
    if (target.kind === "existing") {
      oldChunks = existingChunkRefs(db, inode);
    } else {
      insertFileDirent(db, target.parentInode, target.leafName, inode, target.canonicalPath);
    }

    const rev = incrementRev(db);
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
      "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, size = ?, manifest_hash = ? WHERE inode = ?",
      mode,
      mtime,
      rev,
      bytes.byteLength,
      manifestHash,
      inode,
    );
  });
}
