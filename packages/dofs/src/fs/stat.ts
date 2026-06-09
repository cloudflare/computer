import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";
import { resolveInode } from "./resolve.js";
import { getPendingWriteBufferByPath, getWriteBuffer } from "./writeBuffer.js";

export interface WorkspaceStatResult {
  name: string;
  mode: number;
  mtime: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
}

export function stat(db: Database, path: string): WorkspaceStatResult {
  const { name, path: canonical } = canonicalizePath(path);
  // Pending-create files have no inode yet; serve the buffer state
  // so callers between create and release see the file as it stands.
  const pending = getPendingWriteBufferByPath(db, canonical);
  if (pending !== undefined && pending.pending !== undefined) {
    return {
      name,
      mode: pending.mode & 0o7777,
      mtime: pending.pending.mtime,
      size: pending.size,
      isFile: true,
      isDirectory: false,
    };
  }
  const node = resolveInode(db, path);
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
  }

  const isDirectory = node.type === "dir";
  const isFile = node.type === "file";
  let size = 0;
  if (isFile) {
    // Prefer the in-memory buffer when an open file has unflushed
    // writes; otherwise read the cached size off vfs_nodes that
    // resolveInode just loaded for us, no extra SQL.
    const buffered = getWriteBuffer(db, node.inode);
    size = buffered?.dirty ? buffered.size : node.size;
  }

  return {
    name,
    mode: node.mode,
    mtime: node.mtime,
    size,
    isFile,
    isDirectory,
  };
}
