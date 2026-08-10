import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";
import { lookupResolveCache, storeResolveCache } from "./resolveCache.js";

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
  const { parts, path: canonical } = canonicalizePath(path);

  // Cache + single-statement CTE serve only cache-eligible reads:
  // follow-symlinks resolutions outside a transaction. Everything else
  // uses the per-component loop:
  //   * followSymlinks:false (lstat / readlink / the provider's
  //     pre-mutation captures) — not cached, and the loop is cheaper
  //     for these shallow one-shot resolves than the recursive CTE.
  //   * inside a transaction (every mutation path) — resolves are
  //     shallow and hot, the CTE competes with the mutation's own
  //     statements for the plan cache (recompiling it is far dearer
  //     than the loop), and the cache must not be populated
  //     mid-transaction anyway (rollback safety).
  // Mutations still invalidate the cache; that is independent of this.
  if (!followFinal || db.inTransaction) {
    return resolveParts(db, parts, followFinal, 0);
  }

  // Repeat reads of the same path are served from the per-Database
  // cache. Only the path -> inode mapping is cached; re-read the node
  // row so mode/size/mtime/type are always current. A stale mapping
  // (inode reaped without invalidation) reads back null and falls
  // through to a full resolve that re-populates the cache.
  const hit = lookupResolveCache(db, canonical);
  if (hit !== undefined) {
    if (hit.kind === "negative") {
      return null;
    }
    const node = readNode(db, hit.inode);
    if (node !== null) {
      return toResolved(node);
    }
  }

  // One recursive-CTE statement resolves the common symlink-free
  // case. Any symlink on the path falls back to the per-component loop,
  // which follows links and enforces ELOOP; those resolutions are not
  // cached (a followed path is an alias whose invalidation can't be
  // reasoned about structurally).
  const cte = resolveViaCte(db, parts);
  if (cte.kind === "symlink") {
    return resolveParts(db, parts, followFinal, 0);
  }
  storeResolveCache(db, canonical, cte.node === null ? null : cte.node.inode);
  return cte.node;
}

interface CteRow {
  level: number;
  inode: number;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  link_target: string | null;
}

type CteResolution =
  // Walk completed with no symlink on the path: `node` is the resolved
  // final node, or null when a segment was missing or an intermediate
  // was not a directory (both map to null, exactly like the loop).
  | { kind: "resolved"; node: ResolvedInode | null }
  // A symlink was encountered anywhere on the path (intermediate or
  // final). The CTE can't follow links, so the caller must fall back to
  // the loop for byte-identical follow / ELOOP / dangling behaviour.
  | { kind: "symlink" };

// Single-statement path walk. Binds the canonical path segments as a
// JSON array and walks vfs_dirents -> vfs_nodes from ROOT_INODE, one
// level per segment. Descends only through directories (WHERE
// w.type = 'dir'), so a file intermediate stalls the walk (ENOTDIR)
// and a missing dirent produces no row (ENOENT) — both surface as a
// missing level-D row, matching the loop's null. Every node the walk
// touches is returned so the caller can detect any symlink and fall
// back.
function resolveViaCte(db: Database, parts: string[]): CteResolution {
  const rows = db.all<CteRow>(
    `WITH RECURSIVE
       segs(level, name) AS (
         SELECT key, value FROM json_each(?)
       ),
       walk(level, inode, type, mode, mtime, size, link_target) AS (
         SELECT 0, n.inode, n.type, n.mode, n.mtime, n.size, n.link_target
           FROM vfs_nodes n
          WHERE n.inode = ?
         UNION ALL
         SELECT w.level + 1, n.inode, n.type, n.mode, n.mtime, n.size, n.link_target
           FROM walk w
           JOIN segs s ON s.level = w.level
           JOIN vfs_dirents d ON d.parent_inode = w.inode AND d.name = s.name
           JOIN vfs_nodes n ON n.inode = d.child_inode
          WHERE w.type = 'dir'
       )
     SELECT level, inode, type, mode, mtime, size, link_target
       FROM walk
      ORDER BY level`,
    JSON.stringify(parts),
    ROOT_INODE,
  );

  const depth = parts.length;
  let target: CteRow | undefined;
  for (const row of rows) {
    // Any symlink on the walk (root is level 0 and always a dir) means
    // the loop must take over to follow it.
    if (row.level >= 1 && row.type === "symlink") {
      return { kind: "symlink" };
    }
    if (row.level === depth) {
      target = row;
    }
  }
  return {
    kind: "resolved",
    node: target === undefined ? null : toResolved(target),
  };
}

function toResolved(node: NodeRow): ResolvedInode {
  return {
    inode: node.inode,
    type: node.type,
    mode: node.mode,
    mtime: node.mtime,
    size: node.size,
    linkTarget: node.link_target ?? undefined,
  };
}

function linkTargetParts(target: string, linkParentParts: string[]): string[] {
  if (target.startsWith("/")) {
    return canonicalizePath(target).parts;
  }

  const resolved = [...linkParentParts];
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved;
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
      const resolved = resolveParts(db, linkTargetParts(target, parts.slice(0, i)), true, follows);
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
