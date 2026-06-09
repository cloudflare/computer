import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";
import { resolveInode } from "./resolve.js";
import { getWriteBuffer } from "./writeBuffer.js";

export interface WorkspaceStatResult {
  name: string;
  mode: number;
  mtime: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
}

export function stat(db: Database, path: string): WorkspaceStatResult {
  const { name } = canonicalizePath(path);
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
    size = buffered !== undefined && buffered.dirty ? buffered.size : node.size;
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
