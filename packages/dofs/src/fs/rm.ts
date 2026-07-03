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
// parents. Yields each node together with the parent inode and name
// the walk already knows, so the caller can unlink the dirent by
// (parent, name) without re-resolving the parent from root. The caller
// appends one tombstone per yielded path and clears vfs_chunks for
// file inodes.
function* walkPostOrder(
  db: Database,
  rootInode: number,
  rootPath: string,
  rootParentInode: number,
  rootName: string,
): Generator<{
  path: string;
  inode: number;
  type: "file" | "dir" | "symlink";
  parentInode: number;
  name: string;
}> {
  // Stack-based DFS to avoid recursion limits on deep trees.
  type Frame = {
    inode: number;
    path: string;
    type: "file" | "dir" | "symlink";
    parentInode: number;
    name: string;
    expanded: boolean;
  };
  const stack: Frame[] = [
    {
      inode: rootInode,
      path: rootPath,
      type: "dir",
      parentInode: rootParentInode,
      name: rootName,
      expanded: false,
    },
  ];

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.type !== "dir" || top.expanded) {
      stack.pop();
      yield {
        path: top.path,
        inode: top.inode,
        type: top.type,
        parentInode: top.parentInode,
        name: top.name,
      };
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
        parentInode: top.inode,
        name: child.name,
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
      // link disappears. `parent` is already resolved above, so unlink
      // by (parent, name) directly rather than re-resolving. The
      // tombstone is recorded at the resolved real path so sync sees
      // the move-aware location.
      unlinkDirent(db, parent.inode, name, node.inode, node.type);
      recordDelete(db, rev, realPath);
      // A single removed entry is a file, symlink, or empty directory:
      // no cached descendants to worry about, so drop it exact.
      invalidateResolveExact(db, realPath);
      return;
    }

    // Recursive directory removal. Walk leaves first so each delete
    // sees an empty parent by the time we get to it. File entries may
    // be hardlinked outside this subtree, so delete by path rather
    // than by child inode. The walk carries each node's parent inode
    // and name, so unlinkDirent needs no per-node re-resolve from root.
    for (const entry of walkPostOrder(db, node.inode, realPath, parent.inode, name)) {
      unlinkDirent(db, entry.parentInode, entry.name, entry.inode, entry.type);
      recordDelete(db, rev, entry.path);
    }
    // The whole subtree under realPath is gone; one subtree drop covers
    // every descendant's cached resolution.
    invalidateResolveSubtree(db, realPath);
  });
}
