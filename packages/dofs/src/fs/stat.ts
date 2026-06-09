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
    const buffered = getWriteBuffer(db, node.inode);
    if (buffered !== undefined && buffered.dirty) {
      size = buffered.size;
    } else {
      size =
        db.scalar<number>(
          "SELECT COALESCE(SUM(size), 0) FROM vfs_chunks WHERE inode = ?",
          node.inode,
        ) ?? 0;
    }
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
