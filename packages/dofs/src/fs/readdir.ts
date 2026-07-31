import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";
import { resolveInode } from "./resolve.js";
import { listPendingByParent } from "./writeBuffer.js";

export interface WorkspaceDirentResult {
  name: string;
  parentPath: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

interface DirentRow {
  name: string;
  type: "file" | "dir" | "symlink";
}

export interface ReaddirOptions {
  /** Maximum committed entries to materialize. Pending entries may extend the result. */
  limit?: number;
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
  const rows = db.all<DirentRow>(
    `SELECT d.name AS name, n.type AS type
       FROM vfs_dirents d
       JOIN vfs_nodes n ON n.inode = d.child_inode
      WHERE d.parent_inode = ?
      ORDER BY d.name
      ${limit === undefined ? "" : "LIMIT ?"}`,
    ...(limit === undefined ? [node.inode] : [node.inode, limit]),
  );

  const entries = rows.map((row) => ({
    name: row.name,
    parentPath: canonical,
    isFile: row.type === "file",
    isDirectory: row.type === "dir",
    isSymbolicLink: row.type === "symlink",
  }));

  // Merge in pending-create buffers parented under this directory so
  // a `readdir` between FUSE create and release still surfaces the
  // file. Skip any whose name already appears in the SQL rows (in
  // case a concurrent commit just landed it).
  const pending = listPendingByParent(db, node.inode);
  if (pending.length > 0) {
    const seen = new Set(entries.map((e) => e.name));
    for (const entry of pending) {
      if (entry.pending === undefined) continue;
      const { leafName } = entry.pending;
      if (seen.has(leafName)) continue;
      entries.push({
        name: leafName,
        parentPath: canonical,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  return entries;
}
