import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";
import { resolveInode } from "./resolve.js";
import {
  getPendingWriteBufferByParent,
  getPendingWriteBufferByPath,
  hasPendingWriteBuffers,
  type WriteBufferEntry,
} from "./writeBuffer.js";

export function findPendingWriteBuffer(db: Database, path: string): WriteBufferEntry | undefined {
  if (!hasPendingWriteBuffers(db)) return undefined;

  const { parts, path: canonical } = canonicalizePath(path);
  const direct = getPendingWriteBufferByPath(db, canonical);
  if (direct !== undefined || parts.length === 0) return direct;

  const leafName = parts.at(-1);
  if (leafName === undefined) return undefined;
  const parentPath = parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
  const parent = resolveInode(db, parentPath);
  if (parent?.type !== "dir") return undefined;
  return getPendingWriteBufferByParent(db, parent.inode, leafName);
}
