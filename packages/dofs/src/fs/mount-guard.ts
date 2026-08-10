// Read-only mount guard.
//
// Every dofs mutating entry point (writeFile, mkdir, rm, and the
// apply path in sync/apply.ts) consults this module to reject
// writes that fall under a registered read-only mount root. The
// guard lives at the data layer so container-side writes that
// arrive via pullOnce -> applyChanges are caught too — the
// workspace-side surface wrapper alone cannot see them.
//
// The set of read-only roots is small (one row per registered
// mount per workspace, typically <10) and changes only at indexer
// write time. Cache it per Database in a WeakMap so repeat lookups
// don't hit SQLite. The mount indexer in @cloudflare/computer
// invalidates the cache via `invalidateReadOnlyMountCache(db)` after
// it writes _vfs_mounts.

import { createWorkspaceError } from "../errors.js";
import type { Database } from "../storage.js";

// undefined sentinel = "not loaded yet"; an empty array means
// "loaded, no read-only mounts registered". The two are not the
// same: the empty case must skip the SQL lookup on every check.
const cache = new WeakMap<Database, readonly string[]>();

// Public so the workspace-side indexer can drop the cache after it
// writes a new _vfs_mounts row. Tests also call it when they stage
// a mount fixture by direct SQL.
export function invalidateReadOnlyMountCache(db: Database): void {
  cache.delete(db);
}

function loadReadOnlyRoots(db: Database): readonly string[] {
  const rows = db.all<{ root: string }>("SELECT root FROM _vfs_mounts WHERE mode = 'read-only'");
  const roots = rows.map((r) => r.root);
  cache.set(db, roots);
  return roots;
}

export function getReadOnlyMountRoots(db: Database): readonly string[] {
  const cached = cache.get(db);
  if (cached !== undefined) return cached;
  return loadReadOnlyRoots(db);
}

// Symmetric overlap check between a candidate write path and a
// mount root. Either:
//   - `path` is at or below `root` (a direct write or rm under the
//     mount root), OR
//   - `root` is below `path` (an ancestor rm that would recurse
//     through the mount).
// Both shapes must be blocked so a read-only mount survives both
// vectors. Mirrors the predicate that lived in
// GuardedWorkspaceFilesystem before the data-layer move.
function isAtOrBelowRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function overlapsRoot(path: string, root: string): boolean {
  return isAtOrBelowRoot(path, root) || root.startsWith(`${path}/`);
}

// Throws EROFS when the path overlaps any read-only mount root.
// Callers should invoke this before any DB mutation. The error
// shape matches the existing createWorkspaceError contract so
// surface callers see a normal WorkspaceFsError.
export function assertNotReadOnly(db: Database, path: string): void {
  const roots = getReadOnlyMountRoots(db);
  if (roots.length === 0) return;
  for (const root of roots) {
    if (overlapsRoot(path, root)) {
      throw createWorkspaceError("EROFS", `read-only mount at ${root}: cannot modify`, path);
    }
  }
}

// Point writes only need to reject paths at or below a read-only root.
// Unlike recursive removal, walking through an ancestor of a mount does
// not modify the protected subtree.
export function assertNotInReadOnlyMount(db: Database, path: string): void {
  const roots = getReadOnlyMountRoots(db);
  for (const root of roots) {
    if (isAtOrBelowRoot(path, root)) {
      throw createWorkspaceError("EROFS", `read-only mount at ${root}: cannot modify`, path);
    }
  }
}

// Variant for callers that already know the path is canonicalised
// and want to reject a single descendant during a recursive walk
// (rm's walkPostOrder). Returns the matching root or undefined; the
// caller decides whether to throw, log, or skip.
export function readOnlyRootFor(db: Database, path: string): string | undefined {
  const roots = getReadOnlyMountRoots(db);
  for (const root of roots) {
    if (overlapsRoot(path, root)) return root;
  }
  return undefined;
}
