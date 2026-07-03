import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";
import { assertNotReadOnly } from "./mount-guard.js";
import { invalidateResolveSubtree } from "./resolveCache.js";

// Create a symlink node. The target is stored as-is — it can be a
// relative or absolute path, dangling or live. resolveInode follows
// it transparently when callers walk through this entry.
export function symlink(db: Database, target: string, path: string, now: () => number): void {
  const { parts, path: canonical } = canonicalizePath(path);
  if (parts.length === 0) {
    throw createWorkspaceError("EEXIST", "cannot symlink onto root", canonical);
  }
  assertNotReadOnly(db, canonical);

  db.transactionSync(() => {
    // Walk to the parent dirent. Intermediate segments must be real
    // directories; we don't auto-create them.
    let parentInode = ROOT_INODE;
    for (let i = 0; i < parts.length - 1; i++) {
      const child = db.one<{ child_inode: number }>(
        "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
        parentInode,
        parts[i],
      );
      if (child === undefined) {
        throw createWorkspaceError("ENOENT", `parent directory missing: ${canonical}`, canonical);
      }
      const next = db.one<{ inode: number; type: "file" | "dir" | "symlink" }>(
        "SELECT inode, type FROM vfs_nodes WHERE inode = ?",
        child.child_inode,
      );
      if (next === undefined || next.type !== "dir") {
        throw createWorkspaceError(
          "ENOTDIR",
          `parent path segment is not a directory: ${canonical}`,
          canonical,
        );
      }
      parentInode = next.inode;
    }

    const leafName = parts[parts.length - 1];
    const existing = db.one<{ child_inode: number }>(
      "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
      parentInode,
      leafName,
    );
    if (existing !== undefined) {
      throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
    }

    const rev = incrementRev(db);
    const mtime = now();
    // RETURNING folds the rowid read into the INSERT.
    const row = db.one<{ inode: number }>(
      "INSERT INTO vfs_nodes (type, mode, mtime, rev, link_target) VALUES ('symlink', ?, ?, ?, ?) RETURNING inode",
      0o777,
      mtime,
      rev,
      target,
    );
    if (row === undefined) {
      throw createWorkspaceError("EIO", "failed to allocate inode");
    }
    const inode = row.inode;
    db.run(
      "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
      parentInode,
      leafName,
      inode,
    );
    // Subtree, not exact: paths *through* the new link (e.g. /s/x when
    // /s -> a populated dir) now resolve, so any cached negative
    // beneath the link must be dropped.
    invalidateResolveSubtree(db, canonical);
  });
}
