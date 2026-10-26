import { createWorkspaceError } from "../errors";
import { canonicalizePath } from "../path";
import { incrementRev } from "../rev";
import { ROOT_INODE } from "../schema/index";
import type { Database } from "../storage";
import { assertNotReadOnly } from "./mount-guard";
import { resolveInode } from "./resolve";
import { invalidateResolveExact } from "./resolveCache";

function resolveParent(db: Database, parts: string[], canonical: string): number {
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

export function link(db: Database, existingPath: string, newPath: string): void {
  const { parts, path: canonicalNew } = canonicalizePath(newPath);
  if (parts.length === 0) {
    throw createWorkspaceError("EEXIST", "cannot link onto root", canonicalNew);
  }

  assertNotReadOnly(db, canonicalNew);

  db.transactionSync(() => {
    const source = resolveInode(db, existingPath);
    if (source === null) {
      throw createWorkspaceError("ENOENT", `no such file: ${existingPath}`, existingPath);
    }
    if (source.type !== "file") {
      throw createWorkspaceError(
        "EPERM",
        `cannot hardlink non-file: ${existingPath}`,
        existingPath,
      );
    }

    const parentInode = resolveParent(db, parts, canonicalNew);
    const leafName = parts[parts.length - 1];
    const existing = db.one<{ child_inode: number }>(
      "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
      parentInode,
      leafName,
    );
    if (existing !== undefined) {
      throw createWorkspaceError("EEXIST", `path exists: ${canonicalNew}`, canonicalNew);
    }

    db.run(
      "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
      parentInode,
      leafName,
      source.inode,
    );
    const rev = incrementRev(db);
    db.run("UPDATE vfs_nodes SET rev = ? WHERE inode = ?", rev, source.inode);
    // A new hardlink name for an existing file: a leaf with no
    // descendants, so drop just the (possibly negative) entry for it.
    invalidateResolveExact(db, canonicalNew);
  });
}
