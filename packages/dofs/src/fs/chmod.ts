import { createWorkspaceError } from "../errors";
import { canonicalizePath } from "../path";
import { incrementRev } from "../rev";
import type { Database } from "../storage";
import { assertNotReadOnly } from "./mount-guard";
import { resolveInode } from "./resolve";
import { getWriteBuffer } from "./writeBuffer";

// Change the file mode bits of a path. Follows symlinks like POSIX
// chmod — the change lands on the target, not the link. Bumps rev
// and mtime so the sync protocol carries the change.
//
// The supplied mode is masked to 12 bits (the permission bits and
// the setuid / setgid / sticky bits). Callers that pass a Node-style
// stat.mode with file-type bits in the upper byte get only the
// permission half stored.
export function chmod(db: Database, path: string, mode: number, now: () => number): void {
  const { path: canonical } = canonicalizePath(path);
  assertNotReadOnly(db, canonical);

  db.transactionSync(() => {
    const node = resolveInode(db, canonical);
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }
    const rev = incrementRev(db);
    db.run(
      "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ? WHERE inode = ?",
      mode & 0o7777,
      now(),
      rev,
      node.inode,
    );
    // An open buffer commits its own mode at release; keep it in step.
    const buffer = getWriteBuffer(db, node.inode);
    if (buffer !== undefined) buffer.mode = mode & 0o7777;
  });
}
