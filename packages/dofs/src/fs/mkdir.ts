import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";
import { assertNotInReadOnlyMount, assertNotReadOnly } from "./mount-guard.js";
import { invalidateResolveExact } from "./resolveCache.js";

export interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}

interface ResolvedSegment {
  inode: number;
  type: "file" | "dir" | "symlink";
  linkTarget: string | null;
}

// Matches resolveInode's Linux-compatible SYMLOOP_MAX so every write
// path enforces the same budget on a single call.
const MAX_SYMLINK_FOLLOWS = 40;

interface SymlinkFollowState {
  count: number;
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
  const node = db.one<{
    inode: number;
    type: "file" | "dir" | "symlink";
    link_target: string | null;
  }>("SELECT inode, type, link_target FROM vfs_nodes WHERE inode = ?", row.child_inode);
  if (node === undefined) {
    return undefined;
  }
  return { inode: node.inode, type: node.type, linkTarget: node.link_target };
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

function countSymlinkFollow(follows: SymlinkFollowState, path: string): void {
  follows.count += 1;
  if (follows.count > MAX_SYMLINK_FOLLOWS) {
    throw createWorkspaceError("ELOOP", "too many symlinks resolving path", path);
  }
}

function pathFromParts(parts: string[]): string {
  return `/${parts.join("/")}`;
}

interface ResolvedParent {
  inode: number;
  // Path of the resolved parent with every intermediate link expanded,
  // so the leaf lands under the directory the links point at.
  realPath: string;
}

// Walk every segment before the leaf, following symbolic links the way
// writeFile does. A link to a directory resolves transparently; a file
// still stops the walk with ENOTDIR, a missing or dangling segment with
// ENOENT, and a cycle with ELOOP once the shared budget is spent.
//
// `recursive` creates the missing segments, and it does so under the
// resolved parent rather than beside the link.
function resolveMkdirParent(
  db: Database,
  parts: string[],
  canonical: string,
  recursive: boolean,
  mtime: number,
  rev: number,
): ResolvedParent {
  // Segments still to walk. A segment that came from a link target
  // carries `fromLink` so a dangling link reports ENOENT rather than
  // being materialised by a recursive create.
  const pending: Array<{ name: string; fromLink: boolean }> = parts
    .slice(0, -1)
    .map((name) => ({ name, fromLink: false }));
  const inodeStack = [ROOT_INODE];
  const realParts: string[] = [];
  const follows: SymlinkFollowState = { count: 0 };

  while (pending.length > 0) {
    const segment = pending.shift();
    if (segment === undefined) continue;
    const { name, fromLink } = segment;
    if (name === "" || name === ".") continue;
    if (name === "..") {
      if (inodeStack.length > 1) {
        inodeStack.pop();
        realParts.pop();
      }
      continue;
    }

    const parentInode = inodeStack[inodeStack.length - 1];
    const existing = lookupChild(db, parentInode, name);
    if (existing === undefined) {
      if (!recursive || fromLink) {
        throw createWorkspaceError("ENOENT", `parent directory missing: ${canonical}`, canonical);
      }
      const created = createDir(db, parentInode, name, 0o755, mtime, rev);
      inodeStack.push(created);
      realParts.push(name);
      // A newly created directory is empty, so a cached negative for
      // its own path is the only stale entry possible; drop it exact.
      invalidateResolveExact(db, pathFromParts(realParts));
      continue;
    }

    if (existing.type === "symlink") {
      countSymlinkFollow(follows, canonical);
      const target = existing.linkTarget ?? "";
      if (target.startsWith("/")) {
        inodeStack.splice(1);
        realParts.splice(0);
      }
      // Re-queue the target's own segments so a link that points
      // through further links, or through `..`, is expanded in
      // filesystem order.
      pending.unshift(...target.split("/").map((part) => ({ name: part, fromLink: true })));
      continue;
    }

    if (existing.type !== "dir") {
      throw createWorkspaceError(
        "ENOTDIR",
        `parent path segment is not a directory: ${canonical}`,
        canonical,
      );
    }
    inodeStack.push(existing.inode);
    realParts.push(name);
  }

  return {
    inode: inodeStack[inodeStack.length - 1],
    realPath: realParts.length === 0 ? "/" : pathFromParts(realParts),
  };
}

export function mkdir(db: Database, path: string, options: MkdirOptions, now: () => number): void {
  mkdirWithGuard(db, path, options, now, assertNotReadOnly);
}

export function mkdirForSyncParents(
  db: Database,
  path: string,
  options: MkdirOptions,
  now: () => number,
): void {
  mkdirWithGuard(db, path, options, now, assertNotInReadOnlyMount);
}

function mkdirWithGuard(
  db: Database,
  path: string,
  options: MkdirOptions,
  now: () => number,
  guard: (db: Database, path: string) => void,
): void {
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
  guard(db, canonical);

  db.transactionSync(() => {
    const rev = incrementRev(db);
    const mtime = now();

    // Walk all but the final segment, following intermediate links.
    const parent = resolveMkdirParent(db, parts, canonical, recursive, mtime, rev);
    const leafName = parts[parts.length - 1];
    const realPath = parent.realPath === "/" ? `/${leafName}` : `${parent.realPath}/${leafName}`;
    // A path that traversed a link can land somewhere the caller's own
    // path never named, so guard the resolved location too.
    if (realPath !== canonical) guard(db, realPath);

    const existing = lookupChild(db, parent.inode, leafName);
    if (existing !== undefined) {
      // EEXIST is correct for both "already a directory" and
      // "already a file" per docs/04. Recursive only swallows the
      // already-a-directory case.
      if (recursive && existing.type === "dir") {
        return;
      }
      throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
    }

    createDir(db, parent.inode, leafName, mode, mtime, rev);
    invalidateResolveExact(db, realPath);
    if (realPath !== canonical) invalidateResolveExact(db, canonical);
  });
}
