import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";
import { assertNotReadOnly } from "./mount-guard.js";
import { resolveInode } from "./resolve.js";

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
  });
}
