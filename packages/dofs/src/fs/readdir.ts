import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";
import { resolveInode } from "./resolve.js";
import { getWriteBuffer, listPendingByParent } from "./writeBuffer.js";

export interface WorkspaceDirentResult {
  name: string;
  parentPath: string;
  size: number;
  mtime: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

interface DirentRow {
  inode: number;
  name: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
  link_target: string | null;
}

export interface ReaddirOptions {
  /** Maximum entries to return. */
  limit?: number;
  /** Number of entries to skip in name order. */
  offset?: number;
}

export function readdir(
  db: Database,
  path: string,
  options: ReaddirOptions = {},
): WorkspaceDirentResult[] {
  const { path: canonical } = canonicalizePath(path);
  const node = resolveInode(db, canonical);
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
  }
  if (node.type !== "dir") {
    throw createWorkspaceError("ENOTDIR", `not a directory: ${canonical}`, canonical);
  }

  const limit = options.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new TypeError("readdir limit must be a non-negative safe integer");
  }
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("readdir offset must be a non-negative safe integer");
  }
  if (limit === 0) return [];

  const pending = listPendingByParent(db, node.inode)
    .filter((entry) => entry.pending !== undefined)
    .map(
      (entry): WorkspaceDirentResult => ({
        name: entry.pending?.leafName ?? "",
        parentPath: canonical,
        size: entry.size,
        mtime: entry.pending?.mtime ?? 0,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      }),
    );

  // Pending creates live outside SQLite until their final release. If there
  // are none, let SQLite apply the requested page directly. Otherwise fetch
  // a narrow committed window around the requested page. Every pending entry
  // can shift the committed offset by at most one position in either
  // direction, so this window is sufficient without materializing the whole
  // prefix before a deep page.
  const queryOffset = pending.length === 0 ? offset : Math.max(0, offset - pending.length);
  const queryLimit =
    pending.length === 0
      ? limit
      : limit === undefined
        ? undefined
        : Math.min(Number.MAX_SAFE_INTEGER, limit + pending.length * 2);
  const rows = readRows(db, node.inode, queryLimit, queryOffset);
  const entries = rows.map((row) => toResult(db, canonical, row));

  if (pending.length === 0) return entries;

  const seen = new Set(entries.map((entry) => entry.name));
  for (const entry of pending) {
    if (!seen.has(entry.name)) entries.push(entry);
  }
  entries.sort(compareByName);
  const localOffset = offset - queryOffset;
  return entries.slice(localOffset, limit === undefined ? undefined : localOffset + limit);
}

function readRows(
  db: Database,
  parentInode: number,
  limit: number | undefined,
  offset: number,
): DirentRow[] {
  const pagination =
    limit !== undefined ? "LIMIT ? OFFSET ?" : offset > 0 ? "LIMIT -1 OFFSET ?" : "";
  const params =
    limit !== undefined
      ? [parentInode, limit, offset]
      : offset > 0
        ? [parentInode, offset]
        : [parentInode];
  return db.all<DirentRow>(
    `SELECT n.inode AS inode,
            d.name AS name,
            n.type AS type,
            n.size AS size,
            n.mtime AS mtime,
            n.link_target AS link_target
       FROM vfs_dirents d
       JOIN vfs_nodes n ON n.inode = d.child_inode
      WHERE d.parent_inode = ?
      ORDER BY d.name
      ${pagination}`,
    ...params,
  );
}

function toResult(db: Database, parentPath: string, row: DirentRow): WorkspaceDirentResult {
  const isFile = row.type === "file";
  const isSymbolicLink = row.type === "symlink";
  const buffered = isFile ? getWriteBuffer(db, row.inode) : undefined;
  const size = isFile
    ? buffered?.dirty
      ? buffered.size
      : row.size
    : isSymbolicLink
      ? (row.link_target ?? "").length
      : 0;
  return {
    name: row.name,
    parentPath,
    size,
    mtime: row.mtime,
    isFile,
    isDirectory: row.type === "dir",
    isSymbolicLink,
  };
}

function compareByName(a: WorkspaceDirentResult, b: WorkspaceDirentResult): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
