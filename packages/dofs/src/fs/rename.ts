import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import type { Database } from "../storage.js";
import { recordDelete } from "../sync/changes.js";
import { pathOf } from "../sync/paths.js";
import { assertNotReadOnly } from "./mount-guard.js";
import { resolveInode } from "./resolve.js";
import { invalidateResolveExact, invalidateResolveSubtree } from "./resolveCache.js";
import { unlinkDirent } from "./unlink.js";

type NodeType = "file" | "dir" | "symlink";

export function rename(db: Database, oldPath: string, newPath: string): void {
  const { path: oldCanonical } = canonicalizePath(oldPath);
  const { parts: newParts, path: newCanonical } = canonicalizePath(newPath);

  if (oldCanonical === "/") {
    throw createWorkspaceError("EINVAL", "cannot rename root", oldCanonical);
  }
  if (newParts.length === 0) {
    throw createWorkspaceError("EINVAL", "cannot rename onto root", newCanonical);
  }

  assertNotReadOnly(db, oldCanonical);
  assertNotReadOnly(db, newCanonical);

  db.transactionSync(() => {
    const source = resolveInode(db, oldCanonical, { followSymlinks: false });
    if (source === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${oldCanonical}`, oldCanonical);
    }

    // Resolve the source's real parent dirent. The parent path is
    // resolved with symlinks followed so a request through a symlinked
    // directory lands on the real container; the inode is then
    // identified by (parent_inode, name) rather than by child_inode so
    // a hardlinked source touches only the requested name.
    const { parts: oldParts } = canonicalizePath(oldCanonical);
    const oldName = oldParts[oldParts.length - 1];
    const oldParentPath = oldParts.length === 1 ? "/" : `/${oldParts.slice(0, -1).join("/")}`;
    const oldParent = resolveInode(db, oldParentPath);
    if (oldParent === null || oldParent.type !== "dir") {
      throw createWorkspaceError("ENOENT", `no such path: ${oldCanonical}`, oldCanonical);
    }
    const oldParentReal = pathOf(db, oldParent.inode);
    if (oldParentReal === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${oldCanonical}`, oldCanonical);
    }
    const oldRealPath = oldParentReal === "/" ? `/${oldName}` : `${oldParentReal}/${oldName}`;
    assertNotReadOnly(db, oldRealPath);

    if (oldCanonical === newCanonical) return;

    const newName = newParts[newParts.length - 1];
    const newParentPath = newParts.length === 1 ? "/" : `/${newParts.slice(0, -1).join("/")}`;
    const newParent = resolveInode(db, newParentPath);
    if (newParent === null || newParent.type !== "dir") {
      throw createWorkspaceError(
        "ENOENT",
        `parent directory missing: ${newCanonical}`,
        newCanonical,
      );
    }
    const newParentReal = pathOf(db, newParent.inode);
    if (newParentReal === null) {
      throw createWorkspaceError(
        "ENOENT",
        `parent directory missing: ${newCanonical}`,
        newCanonical,
      );
    }
    const newRealPath = newParentReal === "/" ? `/${newName}` : `${newParentReal}/${newName}`;
    assertNotReadOnly(db, newRealPath);

    // A rename whose source and destination resolve to the very same
    // dirent (same real parent and name, e.g. through a symlinked path)
    // is a true no-op: leave the tree and the change stream untouched.
    // This is distinct from renaming one hardlink onto another, where
    // the names differ and the source link must still be removed.
    if (oldParent.inode === newParent.inode && oldName === newName) return;

    const existing = db.one<{ child_inode: number; type: "file" | "dir" | "symlink" }>(
      `SELECT d.child_inode AS child_inode, n.type AS type
         FROM vfs_dirents d
         JOIN vfs_nodes n ON n.inode = d.child_inode
        WHERE d.parent_inode = ? AND d.name = ?`,
      newParent.inode,
      newName,
    );

    // Authoritative directory self-move guard. It tests the *resolved*
    // destination parent inode against the source subtree, so it catches
    // a symlinked destination that lands inside the source and allows one
    // that resolves outside it. A textual prefix test on the unresolved
    // path could do neither and is intentionally absent.
    if (
      source.type === "dir" &&
      renamedSubtreeContains(db, source.inode, oldRealPath, newParent.inode)
    ) {
      throw createWorkspaceError(
        "EINVAL",
        `cannot rename a directory into itself: ${oldRealPath}`,
        newCanonical,
      );
    }

    if (existing !== undefined) {
      assertCompatibleOverwrite(source.type, existing.type, newCanonical);
      if (existing.type === "dir") {
        const childCount = db.scalar<number>(
          "SELECT COUNT(*) FROM vfs_dirents WHERE parent_inode = ?",
          existing.child_inode,
        );
        if ((childCount ?? 0) > 0) {
          throw createWorkspaceError("ENOTEMPTY", `not empty: ${newCanonical}`, newCanonical);
        }
      }
      // Displace only the destination name. The displaced inode may
      // carry other hardlinks (or be the source inode itself), so reap
      // its chunks and node row only once the final link disappears.
      // Order matters: displace before unlinking the source so a
      // hardlink-onto-hardlink rename never momentarily drops to zero
      // links and reaps the inode it is about to re-point.
      unlinkDirent(db, newParent.inode, newName, existing.child_inode, existing.type);
    }

    // Unlink only the source name; a hardlinked source keeps its other
    // names alive.
    db.run("DELETE FROM vfs_dirents WHERE parent_inode = ? AND name = ?", oldParent.inode, oldName);
    db.run(
      "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
      newParent.inode,
      newName,
      source.inode,
    );

    const rev = incrementRev(db);
    // Rename is represented on the wire as old-path tombstones plus
    // live entries for the moved inode subtree, so stamp only that
    // subtree with the shared rev. Parent directory mtimes are left
    // unchanged on purpose; this diverges from POSIX rename(2), but
    // avoids treating the old and new parents as content changes. A
    // directory move stamps and tombstones its whole subtree in two
    // set-based statements; a file or symlink touches one inode and
    // one path.
    if (source.type === "dir") {
      stampRenamedSubtree(db, source.inode, oldRealPath, rev);
    } else {
      db.run("UPDATE vfs_nodes SET rev = ? WHERE inode = ?", rev, source.inode);
      recordDelete(db, rev, oldRealPath);
    }

    // Drop cached resolutions for both endpoints. A directory move
    // changes every descendant's path, so both sides need a subtree
    // drop; a file/symlink move only touches the two leaf paths. The
    // destination drop also covers any entry displaced by an overwrite.
    if (source.type === "dir") {
      invalidateResolveSubtree(db, oldRealPath);
      invalidateResolveSubtree(db, newRealPath);
    } else {
      invalidateResolveExact(db, oldRealPath);
      invalidateResolveExact(db, newRealPath);
    }
  });
}

function assertCompatibleOverwrite(
  sourceType: NodeType,
  existingType: NodeType,
  path: string,
): void {
  if (sourceType === "dir" && existingType === "dir") return;
  if (existingType === "dir") {
    throw createWorkspaceError("EISDIR", `cannot overwrite directory: ${path}`, path);
  }
  if (sourceType === "dir") {
    throw createWorkspaceError("ENOTDIR", `cannot overwrite non-directory: ${path}`, path);
  }
}

// Recursive walk of a directory subtree seeded at an inode and its
// path. Descends through directory dirents only, so files and symlinks
// are leaves and each hardlink name yields its own row (matching the
// per-component collection it replaces). Bound as a reusable WITH
// clause whose two placeholders are the seed inode and path; callers
// append their own projection.
const SUBTREE_CTE = `WITH RECURSIVE subtree(inode, type, path) AS (
  SELECT ?, 'dir', ?
  UNION ALL
  SELECT n.inode, n.type,
         CASE WHEN s.path = '/' THEN '/' || d.name ELSE s.path || '/' || d.name END
    FROM subtree s
    JOIN vfs_dirents d ON d.parent_inode = s.inode
    JOIN vfs_nodes n ON n.inode = d.child_inode
   WHERE s.type = 'dir'
)`;

function renamedSubtreeContains(
  db: Database,
  rootInode: number,
  rootPath: string,
  targetInode: number,
): boolean {
  const hit = db.one<{ hit: number }>(
    `${SUBTREE_CTE} SELECT 1 AS hit FROM subtree WHERE inode = ? LIMIT 1`,
    rootInode,
    rootPath,
    targetInode,
  );
  return hit !== undefined;
}

// Stamp the shared rev on every inode in the moved subtree and record
// an old-path tombstone for each entry, in two set-based statements
// over the same walk.
function stampRenamedSubtree(db: Database, rootInode: number, rootPath: string, rev: number): void {
  db.run(
    `${SUBTREE_CTE} UPDATE vfs_nodes SET rev = ? WHERE inode IN (SELECT inode FROM subtree)`,
    rootInode,
    rootPath,
    rev,
  );
  db.run(
    `${SUBTREE_CTE} INSERT INTO vfs_changes (rev, path, op) SELECT ?, path, 'delete' FROM subtree ORDER BY path`,
    rootInode,
    rootPath,
    rev,
  );
}
