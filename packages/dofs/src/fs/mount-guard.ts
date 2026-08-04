// Write guard.
//
// Two separate things can refuse a write, and both report EROFS.
//
// The first is a read-only mount root. Every dofs mutating entry
// point (writeFile, mkdir, rm, and the apply path in sync/apply.ts)
// consults this module to reject writes that fall under a
// registered read-only mount root. That check lives at the data
// layer so container-side writes arriving via pullOnce ->
// applyChanges are caught too, which a surface wrapper alone
// cannot see.
//
// The second is a write capability, and it belongs to whoever holds
// the filesystem handle rather than to the data. A caller that
// builds a WorkspaceFilesystem or SQLiteWorkspaceProvider with
// `writable: false` gets a handle that refuses every mutation for
// as long as it exists. The point is to run one command without
// write access: a command is not atomic, so deciding per write
// would let the first forty writes land before the forty-first is
// refused. A capability fixed for the handle's lifetime cannot
// produce that state.
//
// Each check sits at the layer that owns its state. The mount mode
// is a property of the stored tree, so it is enforced next to the
// tree. The capability is a property of the handle, so it is
// enforced on the handle's own methods, where the flag is
// immutable and cannot be flipped part-way through a write.
//
// The set of read-only roots is small (one row per registered
// mount per workspace, typically <10) and changes only at indexer
// write time. Cache it per Database in a WeakMap so repeat lookups
// don't hit SQLite. The mount indexer in @cloudflare/computer
// invalidates the cache via `invalidateReadOnlyMountCache(db)` after
// it writes _vfs_mounts.

import { createWorkspaceError } from "../errors.js";
import type { Database } from "../storage.js";

/**
 * A handle's write access. `WorkspaceFilesystem` and
 * `SQLiteWorkspaceProvider` both satisfy this, so they can pass
 * themselves to `assertWritable`.
 *
 * The field is deliberately immutable on both. A mutable flag would
 * reopen the window the capability exists to close: `writeFile`
 * checks once and then awaits its source stream many times before
 * committing, so a flag that could change mid-call would let a write
 * that was refused on entry still land.
 */
export interface WriteCapability {
  readonly writable: boolean;
}

/**
 * Throws EROFS when the handle has no write access. Call this before
 * any mutation on a surface that carries a capability.
 *
 * The message is distinct from the mount-root message below so a
 * caller reading `error.message` can tell a command that was denied
 * write access from a command that reached into a read-only mount.
 */
export function assertWritable(capability: WriteCapability, path: string): void {
  if (capability.writable) return;
  throw createWorkspaceError("EROFS", "read-only access: cannot modify", path);
}

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
function overlapsRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`);
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
