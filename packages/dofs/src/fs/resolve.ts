import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";

export interface ResolvedInode {
  inode: number;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  // Cached file size from vfs_nodes.size. Always 0 for directories
  // and symlinks; for files this matches SUM(vfs_chunks.size) for
  // the inode. Stat callers consume it directly instead of doing a
  // separate aggregate query.
  size: number;
  // Populated only when type === "symlink". Higher layers (readlink,
  // lstat) consume this; resolveInode follows it transparently unless
  // the caller asks otherwise.
  linkTarget?: string;
}

export interface ResolveOptions {
  // Default true. Pass false to land on a symlink itself — the
  // lstat / readlink code paths rely on this. Loops are still
  // detected when following.
  followSymlinks?: boolean;
}

interface NodeRow {
  inode: number;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  link_target: string | null;
}

interface ChildRow {
  child_inode: number;
}

// Cap the total number of symlinks resolved across a single
// resolveInode() call. Matches Linux's default SYMLOOP_MAX of 40.
const MAX_SYMLINK_FOLLOWS = 40;

// Walk vfs_dirents from ROOT_INODE down to `path`. Returns null when
// any segment is missing, when an intermediate segment is a file
// (which a real filesystem would surface as ENOTDIR — callers map
// the `null` to the appropriate POSIX code), or when a final-segment
// symlink dangles. Throws ELOOP when a cycle is detected.
//
// `path` is canonicalized internally so callers can pass user input
// directly. Pre-canonicalized paths are also accepted and incur the
// same trivial re-canonicalization cost.
export function resolveInode(
  db: Database,
  path: string,
  options: ResolveOptions = {},
): ResolvedInode | null {
  const followFinal = options.followSymlinks !== false;
  return resolveParts(db, canonicalizePath(path).parts, followFinal, 0);
}

function resolveParts(
  db: Database,
  parts: string[],
  followFinal: boolean,
  follows: number,
): ResolvedInode | null {
  const root = readNode(db, ROOT_INODE);
  if (root === null) {
    return null;
  }

  let current: NodeRow = root;
  for (let i = 0; i < parts.length; i++) {
    const isFinal = i === parts.length - 1;
    if (current.type !== "dir") {
      return null;
    }
    const child = db.one<ChildRow>(
      "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
      current.inode,
      parts[i],
    );
    if (child === undefined) {
      return null;
    }
    const next = readNode(db, child.child_inode);
    if (next === null) {
      return null;
    }
    // Intermediate symlinks always get followed; final-segment symlinks
    // are only followed when the caller wants. A dangling intermediate
    // is the same as a missing intermediate (return null).
    if (next.type === "symlink" && (!isFinal || followFinal)) {
      follows += 1;
      if (follows > MAX_SYMLINK_FOLLOWS) {
        throw createWorkspaceError("ELOOP", "too many symlinks resolving path");
      }
      const target = next.link_target ?? "";
      const resolved = resolveParts(db, canonicalizePath(target).parts, true, follows);
      if (resolved === null) {
        return null;
      }
      // Replace the current dirent-resolved node with the followed
      // result, then keep walking remaining segments (if any).
      current = {
        inode: resolved.inode,
        type: resolved.type,
        mode: resolved.mode,
        mtime: resolved.mtime,
        size: resolved.size,
        link_target: resolved.linkTarget ?? null,
      };
      continue;
    }
    current = next;
  }

  return {
    inode: current.inode,
    type: current.type,
    mode: current.mode,
    mtime: current.mtime,
    size: current.size,
    linkTarget: current.link_target ?? undefined,
  };
}

function readNode(db: Database, inode: number): NodeRow | null {
  const row = db.one<NodeRow>(
    "SELECT inode, type, mode, mtime, size, link_target FROM vfs_nodes WHERE inode = ?",
    inode,
  );
  return row ?? null;
}
