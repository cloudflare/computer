import type { Database } from "../storage";
import { deleteNode, dropChunks } from "./refs";

type NodeType = "file" | "dir" | "symlink";

// Remove a single (parent, name) dirent and reap the child inode's
// node and chunk rows only once its last link disappears. A file inode
// can carry several hardlink names, so the node and its chunks survive
// until the final dirent is gone. Returns true when the inode was
// reaped, false when other links keep it alive.
//
// Callers own rev bumps and tombstones. This helper deletes the
// vfs_dirents row itself and leaves vfs_chunks and vfs_nodes to
// fs/refs.ts. It is the single place the refcount-gated removal is
// implemented: rm, rename, and the sync apply path all funnel through
// here so the invariant lives once.
export function unlinkDirent(
  db: Database,
  parentInode: number,
  name: string,
  childInode: number,
  type: NodeType,
): boolean {
  db.run("DELETE FROM vfs_dirents WHERE parent_inode = ? AND name = ?", parentInode, name);
  const remaining = db.scalar<number>(
    "SELECT COUNT(*) FROM vfs_dirents WHERE child_inode = ?",
    childInode,
  );
  if ((remaining ?? 0) > 0) return false;

  if (type === "file") {
    dropChunks(db, childInode);
  }
  deleteNode(db, childInode);
  return true;
}
