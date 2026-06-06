import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import type { Database } from "../storage.js";
import { recordDelete } from "../sync/changes.js";
import { pathOf } from "../sync/paths.js";
import { assertNotReadOnly } from "./mount-guard.js";
import { resolveInode } from "./resolve.js";
import { unlinkDirent } from "./unlink.js";

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

interface DirChild {
  name: string;
  child_inode: number;
  type: "file" | "dir" | "symlink";
}

// Walk a directory subtree post-order so we delete leaves before
// parents. Yields { path, inode, type } for each node to remove. The
// caller appends one tombstone per yielded path and clears
// vfs_chunks for file inodes.
function* walkPostOrder(
  db: Database,
  rootInode: number,
  rootPath: string,
): Generator<{ path: string; inode: number; type: "file" | "dir" | "symlink" }> {
  // Stack-based DFS to avoid recursion limits on deep trees.
  type Frame = { inode: number; path: string; type: "file" | "dir" | "symlink"; expanded: boolean };
  const stack: Frame[] = [{ inode: rootInode, path: rootPath, type: "dir", expanded: false }];

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.type !== "dir" || top.expanded) {
      stack.pop();
      yield { path: top.path, inode: top.inode, type: top.type };
      continue;
    }
    top.expanded = true;
    const children = db.all<DirChild>(
      `SELECT d.name AS name, d.child_inode AS child_inode, n.type AS type
         FROM vfs_dirents d
         JOIN vfs_nodes n ON n.inode = d.child_inode
        WHERE d.parent_inode = ?
        ORDER BY d.name`,
      top.inode,
    );
    for (const child of children) {
      const childPath = top.path === "/" ? `/${child.name}` : `${top.path}/${child.name}`;
      stack.push({
        inode: child.child_inode,
        path: childPath,
        type: child.type,
        expanded: false,
      });
    }
  }
}

export function rm(db: Database, path: string, options: RmOptions): void {
  const { parts, path: canonical } = canonicalizePath(path);

  if (parts.length === 0) {
    // The workspace root is structural; refuse to delete it even with
    // recursive+force. Matches the doc's example.
    throw createWorkspaceError("EPERM", `cannot remove the root directory`, canonical);
  }

  // assertNotReadOnly uses the symmetric overlap predicate, so a
  // recursive rm of an ancestor whose subtree contains a read-only
  // mount root is caught here without walking the tree.
  assertNotReadOnly(db, canonical);

  const force = options.force === true;
  const recursive = options.recursive === true;

  db.transactionSync(() => {
    const node = resolveInode(db, canonical, { followSymlinks: false });
    if (node === null) {
      if (force) return;
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }

    if (node.type === "dir" && !recursive) {
      const childCount = db.scalar<number>(
        "SELECT COUNT(*) FROM vfs_dirents WHERE parent_inode = ?",
        node.inode,
      );
      if ((childCount ?? 0) > 0) {
        throw createWorkspaceError("ENOTEMPTY", `directory not empty: ${canonical}`, canonical);
      }
    }

    // Resolve the entry's real path from its parent rather than from
    // the inode: a hardlinked file has several names, and pathOf would
    // pick an arbitrary one. Following symlinks on the parent lets a
    // request through a symlinked directory land on the real container
    // while still removing exactly the requested name.
    const name = parts[parts.length - 1];
    const parentPath = parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
    const parent = resolveInode(db, parentPath);
    if (parent === null || parent.type !== "dir") {
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }
    const parentReal = pathOf(db, parent.inode);
    if (parentReal === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }
    const realPath = parentReal === "/" ? `/${name}` : `${parentReal}/${name}`;
    assertNotReadOnly(db, realPath);

    const rev = incrementRev(db);

    if (node.type !== "dir" || !recursive) {
      // Single entry removal — file, symlink, or empty directory. A
      // file inode may have multiple dirents (hardlinks), so remove
      // only the requested name and reap chunks/node after the final
      // link disappears. The tombstone is recorded at the resolved
      // real path so sync sees the move-aware location.
      removeEntry(db, realPath, node.inode, node.type);
      recordDelete(db, rev, realPath);
      return;
    }

    // Recursive directory removal. Walk leaves first so each delete
    // sees an empty parent by the time we get to it. File entries may
    // be hardlinked outside this subtree, so delete by path rather
    // than by child inode.
    for (const entry of walkPostOrder(db, node.inode, realPath)) {
      removeEntry(db, entry.path, entry.inode, entry.type);
      recordDelete(db, rev, entry.path);
    }
  });
}

function removeEntry(
  db: Database,
  path: string,
  inode: number,
  type: "file" | "dir" | "symlink",
): void {
  const { parts, path: canonical } = canonicalizePath(path);
  const name = parts[parts.length - 1];
  const parentPath = parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
  const parent = resolveInode(db, parentPath, { followSymlinks: false });
  if (parent === null || parent.type !== "dir") {
    throw createWorkspaceError("ENOENT", `parent directory missing: ${canonical}`, canonical);
  }

  unlinkDirent(db, parent.inode, name, inode, type);
}
