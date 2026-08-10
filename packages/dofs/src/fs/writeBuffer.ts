// In-process write buffer cache.
//
// Holds per-inode mutable byte buffers between an explicit open and
// release. While a buffer is open, all reads and writes for that
// inode go through the buffer rather than the SQLite blob/chunk
// store. Release commits the bytes to chunks once per file
// and evicts the entry, so per-syscall writes no longer accumulate
// orphan blob rows in the store.
//
// The cache is keyed by Database so a fresh database (a test, a
// rebooted DO incarnation) starts with an empty cache.

import type { Database } from "../storage.js";

export interface WriteBufferEntry {
  // Growable backing store. byteLength is capacity; logical length
  // lives in `size`.
  buf: Uint8Array;
  // Logical end-of-file in `buf`.
  size: number;
  // True once writeRange/truncate mutates the buffer. A non-dirty
  // buffer is one that the caller opened but never wrote to; release
  // is a no-op in that case so we do not touch the existing chunks.
  dirty: boolean;
  // Open handle count. Each FUSE open/create increments this; each
  // release decrements. The buffer commits and evicts when the count
  // reaches zero.
  openCount: number;
  // Mode the caller wants persisted on release. Defaults to the
  // inode's existing mode at open time when the caller has none.
  mode: number;
  // Pending-create state. When set, no inode row exists yet; release
  // will INSERT the node + dirent + chunks in one transaction. The
  // synthetic inode id used to key this entry in the cache is stored
  // here so release can find and remove the entry without scanning
  // the cache.
  pending?: {
    parentInode: number;
    leafName: string;
    canonicalPath: string;
    resolvedPath: string;
    pendingInode: number;
    mtime: number;
  };
}

interface DatabaseCache {
  byInode: Map<number, WriteBufferEntry>;
  byPendingPath: Map<string, WriteBufferEntry>;
  nextPendingInode: number;
}

const caches = new WeakMap<Database, DatabaseCache>();

function cacheFor(db: Database): DatabaseCache {
  let cache = caches.get(db);
  if (cache === undefined) {
    cache = { byInode: new Map(), byPendingPath: new Map(), nextPendingInode: -1 };
    caches.set(db, cache);
  }
  return cache;
}

export function getWriteBuffer(db: Database, inode: number): WriteBufferEntry | undefined {
  return caches.get(db)?.byInode.get(inode);
}

export function getPendingWriteBufferByPath(
  db: Database,
  canonicalPath: string,
): WriteBufferEntry | undefined {
  return caches.get(db)?.byPendingPath.get(canonicalPath);
}

// List pending-create buffers whose parent dirent matches `parentInode`.
// Used by readdir so freshly-created-but-not-yet-released files show
// up in directory listings between open and release.
export function listPendingByParent(db: Database, parentInode: number): WriteBufferEntry[] {
  return listPendingWriteBuffers(db).filter((entry) => entry.pending?.parentInode === parentInode);
}

export function listPendingWriteBuffers(db: Database): WriteBufferEntry[] {
  const cache = caches.get(db);
  if (cache === undefined) return [];
  return [...cache.byInode.values()].filter((entry) => entry.pending !== undefined);
}

export function setWriteBuffer(db: Database, inode: number, entry: WriteBufferEntry): void {
  const cache = cacheFor(db);
  cache.byInode.set(inode, entry);
  if (entry.pending !== undefined) {
    cache.byPendingPath.set(entry.pending.canonicalPath, entry);
    cache.byPendingPath.set(entry.pending.resolvedPath, entry);
  }
}

export function deleteWriteBuffer(db: Database, inode: number): void {
  const cache = caches.get(db);
  if (cache === undefined) return;
  const entry = cache.byInode.get(inode);
  if (entry?.pending !== undefined) {
    cache.byPendingPath.delete(entry.pending.canonicalPath);
    cache.byPendingPath.delete(entry.pending.resolvedPath);
  }
  cache.byInode.delete(inode);
}

// Allocate a synthetic negative inode id for a pending file. The
// real id is assigned by SQLite when release INSERTs the node row;
// the synthetic value just lets the buffer cache key entries
// before that point.
export function allocatePendingInode(db: Database): number {
  const cache = cacheFor(db);
  const next = cache.nextPendingInode;
  cache.nextPendingInode -= 1;
  return next;
}

// Re-key a pending entry to the real inode assigned by SQLite at
// commit time, dropping the pending-path index.
export function promotePendingToInode(db: Database, pendingInode: number, realInode: number): void {
  const cache = caches.get(db);
  if (cache === undefined) return;
  const entry = cache.byInode.get(pendingInode);
  if (entry === undefined) return;
  if (entry.pending !== undefined) {
    cache.byPendingPath.delete(entry.pending.canonicalPath);
    cache.byPendingPath.delete(entry.pending.resolvedPath);
    entry.pending = undefined;
  }
  cache.byInode.delete(pendingInode);
  cache.byInode.set(realInode, entry);
}

export function ensureCapacity(entry: WriteBufferEntry, needed: number): void {
  if (entry.buf.byteLength >= needed) return;
  let cap = Math.max(entry.buf.byteLength * 2, 64 * 1024);
  while (cap < needed) cap *= 2;
  const next = new Uint8Array(cap);
  next.set(entry.buf.subarray(0, entry.size), 0);
  entry.buf = next;
}
