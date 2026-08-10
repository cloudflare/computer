import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";
import { findPendingWriteBuffer } from "./pendingWriteBuffer.js";
import { resolveInode } from "./resolve.js";
import { getWriteBuffer } from "./writeBuffer.js";

export interface WorkspaceStatResult {
  name: string;
  // Inode of the resolved node, or 0 for a pending-create file that
  // has no inode yet. Exposed so provider stat surfaces can read the
  // inode from the same resolve instead of walking the path twice.
  inode: number;
  mode: number;
  mtime: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  // True when the result describes a symlink itself rather than
  // its target. Only lstat() can produce a true value here; stat()
  // follows links and reports the final node.
  isSymbolicLink: boolean;
}

export function stat(db: Database, path: string): WorkspaceStatResult {
  return statShared(db, path, true);
}

// Like stat, but does not follow a trailing symlink. Mirrors POSIX
// lstat: the returned size for a symlink is the byte length of the
// stored target, and mode is the symlink node's own mode.
export function lstat(db: Database, path: string): WorkspaceStatResult {
  return statShared(db, path, false);
}

function statShared(db: Database, path: string, followFinal: boolean): WorkspaceStatResult {
  const { name, path: canonical } = canonicalizePath(path);
  // Pending-create files have no inode yet; serve the buffer state
  // so callers between create and release see the file as it stands.
  // Pending creates never apply to symlinks, so this is safe to run
  // even on the lstat path — a hit here always corresponds to a
  // file mid-open.
  const pending = findPendingWriteBuffer(db, canonical);
  if (pending !== undefined && pending.pending !== undefined) {
    return {
      name,
      // A pending create has no inode until releaseWriteBufferSync
      // commits it; report 0, which yields nlink 1 in the provider.
      inode: 0,
      mode: pending.mode & 0o7777,
      mtime: pending.pending.mtime,
      size: pending.size,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    };
  }
  const node = resolveInode(db, path, { followSymlinks: followFinal });
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
  }

  const isDirectory = node.type === "dir";
  const isFile = node.type === "file";
  const isSymbolicLink = node.type === "symlink";
  let size = 0;
  if (isFile) {
    // Prefer the in-memory buffer when an open file has unflushed
    // writes; otherwise read the cached size off vfs_nodes that
    // resolveInode just loaded for us, no extra SQL.
    const buffered = getWriteBuffer(db, node.inode);
    size = buffered?.dirty ? buffered.size : node.size;
  } else if (isSymbolicLink) {
    size = (node.linkTarget ?? "").length;
  }

  return {
    name,
    inode: node.inode,
    mode: node.mode,
    mtime: node.mtime,
    size,
    isFile,
    isDirectory,
    isSymbolicLink,
  };
}
