import type { Database } from "../storage.js";

type NodeType = "file" | "dir" | "symlink";

// Remove a single (parent, name) dirent and reap the child inode's
// node and chunk rows only once its last link disappears. A file inode
// can carry several hardlink names, so the node and its chunks survive
// until the final dirent is gone. Returns true when the inode was
// reaped, false when other links keep it alive.
//
// Callers own rev bumps and tombstones; this helper touches only
// vfs_dirents, vfs_chunks, and vfs_nodes. It is the single place the
// refcount-gated reap is implemented — rm, rename, and the sync apply
// path all funnel through here so the invariant lives once.
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
    db.run("DELETE FROM vfs_chunks WHERE inode = ?", childInode);
  }
  db.run("DELETE FROM vfs_nodes WHERE inode = ?", childInode);
  return true;
}
