import { createWorkspaceError } from "../errors";
import { canonicalizePath } from "../path";
import { incrementRev } from "../rev";
import type { Database } from "../storage";
import { recordDelete } from "../sync/changes";
import { versionFingerprint } from "../sync/fingerprint";
import { pathOf } from "../sync/paths";
import { assertNotReadOnly } from "./mount-guard";
import { resolveFollowing } from "./resolve";
import { invalidateResolveExact, invalidateResolveSubtree } from "./resolveCache";
import { unlinkDirent } from "./unlink";

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

// The single entry `rm` removed, and whether its inode went with it. A
// recursive removal, or a forced removal of nothing, returns undefined.
export interface RemovedEntry {
  inode: number;
  reaped: boolean;
}

export function rm(db: Database, path: string, options: RmOptions): RemovedEntry | undefined {
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

  return db.transactionSync(() => {
    // Resolve the parent, following symlinks, and read the entry from
    // its dirent: the same node a no-follow resolve of the full path
    // lands on, without walking the path twice. Removing by (parent,
    // name) rather than by inode keeps a hardlinked file's other names.
    const name = parts[parts.length - 1];
    const parentPath = parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
    const { node: parent, followedSymlink } = resolveFollowing(db, parentPath);
    const node =
      parent?.type === "dir"
        ? db.one<{ inode: number; type: "file" | "dir" | "symlink" }>(
            `SELECT n.inode AS inode, n.type AS type
               FROM vfs_dirents d
               JOIN vfs_nodes n ON n.inode = d.child_inode
              WHERE d.parent_inode = ? AND d.name = ?`,
            parent.inode,
            name,
          )
        : undefined;
    if (parent?.type !== "dir" || node === undefined) {
      if (force) return undefined;
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

    // Tombstones carry the real path, so a request through a symlinked
    // directory records the name where it actually lived.
    const parentReal = followedSymlink ? pathOf(db, parent.inode) : parentPath;
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
      // Fingerprint before unlinking: the last link takes the node row.
      const prior = versionFingerprint(db, node.inode);
      const reaped = unlinkDirent(db, parent.inode, name, node.inode, node.type);
      recordDelete(db, rev, realPath, prior);
      // A single removed entry is a file, symlink, or empty directory:
      // no cached descendants to worry about, so drop it exact.
      invalidateResolveExact(db, realPath);
      return { inode: node.inode, reaped };
    }

    // Recursive directory removal. Walk leaves first so each delete
    // sees an empty parent by the time we get to it. File entries may
    // be hardlinked outside this subtree, so delete by path rather
    // than by child inode. The walk carries each node's parent inode
    // and name, so unlinkDirent needs no per-node re-resolve from root.
    for (const entry of walkPostOrder(db, node.inode, realPath, parent.inode, name)) {
      const prior = versionFingerprint(db, entry.inode);
      unlinkDirent(db, entry.parentInode, entry.name, entry.inode, entry.type);
      recordDelete(db, rev, entry.path, prior);
    }
    // The whole subtree under realPath is gone; one subtree drop covers
    // every descendant's cached resolution.
    invalidateResolveSubtree(db, realPath);
    return undefined;
  });
}
