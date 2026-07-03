import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";
import { assertNotReadOnly } from "./mount-guard.js";
import { invalidateResolveExact } from "./resolveCache.js";

export interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}

interface ResolvedSegment {
  inode: number;
  type: "file" | "dir";
}

// Look up a child by name under a parent directory. Returns undefined
// when there's no dirent. The caller decides whether that's an error.
function lookupChild(db: Database, parentInode: number, name: string): ResolvedSegment | undefined {
  const row = db.one<{ child_inode: number }>(
    "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
    parentInode,
    name,
  );
  if (row === undefined) {
    return undefined;
  }
  const node = db.one<{ inode: number; type: "file" | "dir" }>(
    "SELECT inode, type FROM vfs_nodes WHERE inode = ?",
    row.child_inode,
  );
  if (node === undefined) {
    return undefined;
  }
  return node;
}

// Create one directory entry under `parentInode`, returning the new
// inode. The caller has already verified the name is not taken.
function createDir(
  db: Database,
  parentInode: number,
  name: string,
  mode: number,
  mtime: number,
  rev: number,
): number {
  // RETURNING folds the rowid read into the INSERT.
  const row = db.one<{ inode: number }>(
    "INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('dir', ?, ?, ?) RETURNING inode",
    mode,
    mtime,
    rev,
  );
  if (row === undefined) {
    throw createWorkspaceError("EIO", "failed to allocate inode");
  }
  const inode = row.inode;
  db.run(
    "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
    parentInode,
    name,
    inode,
  );
  return inode;
}

export function mkdir(db: Database, path: string, options: MkdirOptions, now: () => number): void {
  const { parts, path: canonical } = canonicalizePath(path);
  const recursive = options.recursive === true;
  const mode = (options.mode ?? 0o755) & 0o7777;

  if (parts.length === 0) {
    // Root always exists post-initializeSchema; mkdir("/") is EEXIST
    // even with recursive (matches Node fs.mkdir's "EEXIST on root"
    // behaviour for non-recursive; for recursive Node returns
    // undefined, but our docs treat mkdir("/") as nonsensical).
    throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
  }
  assertNotReadOnly(db, canonical);

  db.transactionSync(() => {
    const rev = incrementRev(db);
    const mtime = now();

    let parentInode = ROOT_INODE;
    // Walk all but the final segment. Each must already exist as a
    // directory; if `recursive`, we create missing ones.
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      const existing = lookupChild(db, parentInode, name);
      if (existing === undefined) {
        if (!recursive) {
          throw createWorkspaceError("ENOENT", `parent directory missing: ${canonical}`, canonical);
        }
        parentInode = createDir(db, parentInode, name, 0o755, mtime, rev);
        // A newly created directory is empty, so a cached negative for
        // its own path is the only stale entry possible; drop it exact.
        invalidateResolveExact(db, `/${parts.slice(0, i + 1).join("/")}`);
        continue;
      }
      if (existing.type !== "dir") {
        throw createWorkspaceError(
          "ENOTDIR",
          `parent path segment is not a directory: ${canonical}`,
          canonical,
        );
      }
      parentInode = existing.inode;
    }

    // Final segment.
    const leafName = parts[parts.length - 1];
    const existing = lookupChild(db, parentInode, leafName);
    if (existing !== undefined) {
      // EEXIST is correct for both "already a directory" and
      // "already a file" per docs/04. Recursive only swallows the
      // already-a-directory case.
      if (recursive && existing.type === "dir") {
        return;
      }
      throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
    }

    createDir(db, parentInode, leafName, mode, mtime, rev);
    invalidateResolveExact(db, canonical);
  });
}
