// Per-Database path -> inode resolution cache.
//
// Maps a canonical absolute path (as produced by
// canonicalizePath().path) to the inode that resolveInode(path,
// { followSymlinks: true }) lands on, or a NEGATIVE marker when the
// path does not resolve. It turns repeat stat/exists/read of the same
// path into an O(1) lookup instead of an O(depth) walk.
//
// Deliberately narrow, for correctness:
//
//   * Only the path -> inode MAPPING is cached. resolveInode always
//     re-reads the node row on a hit, so content changes (chmod,
//     size/mtime, type) are never served stale — only structural
//     mutations that move a dirent can invalidate an entry.
//
//   * Only symlink-free resolutions are cached. Following a symlink
//     makes the cached path an alias of the target whose invalidation
//     can't be reasoned about from the path alone, so resolveInode
//     stores nothing when a symlink was traversed.
//
//   * Population is gated on Database.inTransaction: entries are only
//     written outside a transaction, so a rolled-back mutation can
//     never leave a positive/negative entry reflecting uncommitted
//     state. Mutations invalidate (drop) freely — dropping is safe
//     under rollback because the worst case is a recompute.
//
// The cache is per-Database (WeakMap) and bounded (LRU by Map
// insertion order, same discipline as blobCache).

import type { Database } from "../storage.js";

// Sentinel value for "this path resolves to nothing" (ENOENT/ENOTDIR).
const NEGATIVE = -1;

// Upper bound on cached paths per Database. Entries are tiny (a string
// key and a number), so this caps memory at a few MB while covering
// the working set of a busy tree.
const MAX_ENTRIES = 8192;

// Keyed by the Database instance, so correctness assumes exactly one
// Database wraps each SqlStorage. Two Databases over the same storage
// would hold independent caches and could serve each other stale
// results; the DO owns a single Database, which upholds this.
const caches = new WeakMap<Database, Map<string, number>>();

function cacheFor(db: Database): Map<string, number> {
  let cache = caches.get(db);
  if (cache === undefined) {
    cache = new Map();
    caches.set(db, cache);
  }
  return cache;
}

export type ResolveCacheHit = { kind: "inode"; inode: number } | { kind: "negative" };

// Look up a canonical path. Returns undefined on a miss, a positive
// inode hit, or a negative (known-absent) hit. Bumps LRU recency.
export function lookupResolveCache(
  db: Database,
  canonicalPath: string,
): ResolveCacheHit | undefined {
  const cache = cacheFor(db);
  const value = cache.get(canonicalPath);
  if (value === undefined) {
    return undefined;
  }
  // Move to most-recent position for LRU eviction.
  cache.delete(canonicalPath);
  cache.set(canonicalPath, value);
  return value === NEGATIVE ? { kind: "negative" } : { kind: "inode", inode: value };
}

// Cache a resolution. `inode === null` records a negative entry. No-op
// while a transaction is active so the cache never reflects
// uncommitted state (rollback safety).
export function storeResolveCache(db: Database, canonicalPath: string, inode: number | null): void {
  if (db.inTransaction) {
    return;
  }
  const cache = cacheFor(db);
  cache.set(canonicalPath, inode === null ? NEGATIVE : inode);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) {
      break;
    }
    cache.delete(oldest.value);
  }
}

// Drop the entry for exactly `canonicalPath`. Use after a mutation
// that changes a single leaf's existence without affecting anything
// beneath it: creating/removing a file, symlink, hardlink, or an
// empty directory. O(1).
export function invalidateResolveExact(db: Database, canonicalPath: string): void {
  const cache = caches.get(db);
  cache?.delete(canonicalPath);
}

// Drop `canonicalPath` and every entry beneath it (keys prefixed
// `canonicalPath + "/"`). Use when a mutation changes a whole subtree's
// resolution: a recursive delete, any directory rename (every
// descendant's path changes), a structural subtree replacement, or a
// symlink create (paths *through* the new link become resolvable, so
// stale negatives beneath it must go). Root ("/") clears everything.
export function invalidateResolveSubtree(db: Database, canonicalPath: string): void {
  const cache = caches.get(db);
  if (cache === undefined || cache.size === 0) {
    return;
  }
  if (canonicalPath === "/") {
    cache.clear();
    return;
  }
  cache.delete(canonicalPath);
  const prefix = `${canonicalPath}/`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

// Drop the entire cache for a Database. Used by tests and available as
// a blunt reset.
export function clearResolveCache(db: Database): void {
  caches.get(db)?.clear();
}
