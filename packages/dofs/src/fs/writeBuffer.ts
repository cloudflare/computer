// In-process write buffer cache.
//
// Holds per-inode mutable byte buffers between an explicit open and
// release. While a buffer is open, all reads and writes for that
// inode go through the buffer rather than the SQLite blob/chunk
// store. Release commits the bytes to chunks/inline once per file
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
}

const caches = new WeakMap<Database, Map<number, WriteBufferEntry>>();

function cacheFor(db: Database): Map<number, WriteBufferEntry> {
  let cache = caches.get(db);
  if (cache === undefined) {
    cache = new Map();
    caches.set(db, cache);
  }
  return cache;
}

export function getWriteBuffer(db: Database, inode: number): WriteBufferEntry | undefined {
  return caches.get(db)?.get(inode);
}

export function setWriteBuffer(db: Database, inode: number, entry: WriteBufferEntry): void {
  cacheFor(db).set(inode, entry);
}

export function deleteWriteBuffer(db: Database, inode: number): void {
  caches.get(db)?.delete(inode);
}

export function ensureCapacity(entry: WriteBufferEntry, needed: number): void {
  if (entry.buf.byteLength >= needed) return;
  let cap = Math.max(entry.buf.byteLength * 2, 64 * 1024);
  while (cap < needed) cap *= 2;
  const next = new Uint8Array(cap);
  next.set(entry.buf.subarray(0, entry.size), 0);
  entry.buf = next;
}
