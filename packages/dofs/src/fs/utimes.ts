import { createWorkspaceError } from "../errors";
import { canonicalizePath } from "../path";
import { incrementRev } from "../rev";
import type { Database } from "../storage";
import { pathsOf } from "../sync/paths";
import { assertNotReadOnly } from "./mount-guard";
import { findPendingWriteBuffer } from "./pendingWriteBuffer";
import { resolveFollowing } from "./resolve";
import { getWriteBuffer } from "./writeBuffer";

// Set the modification time of a path, in milliseconds as stored,
// rounded to a whole millisecond. Follows symlinks like utimes(2) and
// bumps rev so the sync protocol carries the change. A file with an
// open write buffer commits this time at release, unless it is written
// or truncated again first.
export function utimes(db: Database, path: string, time: number): void {
  const { path: canonical } = canonicalizePath(path);
  assertNotReadOnly(db, canonical);
  if (!Number.isFinite(time)) {
    throw createWorkspaceError("EINVAL", `invalid modification time: ${time}`, canonical);
  }
  const mtime = Math.round(time);

  const pending = findPendingWriteBuffer(db, canonical);
  if (pending?.pending !== undefined) {
    assertNotReadOnly(db, pending.pending.resolvedPath);
    pending.pending.mtime = mtime;
    pending.mtime = mtime;
    return;
  }

  db.transactionSync(() => {
    const { node, followedSymlink } = resolveFollowing(db, canonical);
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }
    // A symlink can lead into a read-only mount the requested path is
    // outside of, so check every name the target is reachable by.
    if (followedSymlink) {
      for (const real of pathsOf(db, node.inode)) assertNotReadOnly(db, real);
    }
    const rev = incrementRev(db);
    db.run("UPDATE vfs_nodes SET mtime = ?, rev = ? WHERE inode = ?", mtime, rev, node.inode);
    const buffer = getWriteBuffer(db, node.inode);
    if (buffer !== undefined) buffer.mtime = mtime;
  });
}
