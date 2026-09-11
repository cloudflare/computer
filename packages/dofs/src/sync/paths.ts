import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";

// Walk vfs_dirents from `inode` up to ROOT_INODE, gathering the path
// segments along the way. Returns null when the inode is unreachable.
export function pathOf(db: Database, inode: number): string | null {
  if (inode === ROOT_INODE) return "/";
  const segments: string[] = [];
  let current = inode;
  // Bound the walk: a million levels deep is well past any real FS;
  // anything beyond that is corruption and should not loop forever.
  for (let i = 0; i < 1_000_000; i++) {
    const row = db.one<{ parent_inode: number; name: string }>(
      "SELECT parent_inode, name FROM vfs_dirents WHERE child_inode = ?",
      current,
    );
    if (row === undefined) return null;
    segments.push(row.name);
    if (row.parent_inode === ROOT_INODE) {
      segments.reverse();
      return `/${segments.join("/")}`;
    }
    current = row.parent_inode;
  }
  return null;
}

// Every path that currently names `inode`. A file may carry several
// hardlink names; pathOf collapses them to one arbitrary name, which
// is wrong for the change stream — every name has to reach the wire so
// the receiver materialises each. Directories cannot be hardlinked, so
// each parent walk is unambiguous.
export function pathsOf(db: Database, inode: number): string[] {
  if (inode === ROOT_INODE) return ["/"];
  const dirents = db.all<{ parent_inode: number; name: string }>(
    "SELECT parent_inode, name FROM vfs_dirents WHERE child_inode = ?",
    inode,
  );
  const paths: string[] = [];
  for (const { parent_inode, name } of dirents) {
    const parent = pathOf(db, parent_inode);
    if (parent === null) continue;
    paths.push(parent === "/" ? `/${name}` : `${parent}/${name}`);
  }
  return paths;
}

// How many inodes to resolve per CTE round. SQLite's parameter limit
// (SQLITE_MAX_VARIABLE_NUMBER, 999 on conservative builds) caps a bound
// json array's practical size; we bind one JSON string, but keeping the
// batches bounded also keeps the recursive walk's working set small.
const PATHS_BATCH_SIZE = 512;

// Batched `pathsOf`. Resolves every inode in `inodes` to all of its
// hardlink names in a fixed number of statements rather than one
// dirent lookup per ancestor per inode.
//
// coalesceChanges calls this once per push tick with the entire set of
// revved inodes. The per-inode version issued O(N x depth) statements
// — ~74k round-trips for a 20k-node node_modules tree, which dominated
// the tick (~30s) even though every one of those lookups was already a
// covering-index hit. The cost was the statement count, not the index.
//
// Shape: seed one row per (target, dirent) so hardlinks fan out, then
// walk `child_inode -> parent_inode` upward, carrying `target` along.
// Rows are ordered deepest-segment-first per target and reassembled in
// JS. An inode with no dirent row (unreachable, or the root) produces
// no seed row and is simply absent from the result — same contract as
// pathsOf returning [] / pathOf returning null.
export function pathsOfMany(db: Database, inodes: readonly number[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (inodes.length === 0) return out;

  // Deduplicate and pull the root out; it has no dirent row.
  const unique: number[] = [];
  const seen = new Set<number>();
  for (const inode of inodes) {
    if (seen.has(inode)) continue;
    seen.add(inode);
    if (inode === ROOT_INODE) {
      out.set(ROOT_INODE, ["/"]);
      continue;
    }
    unique.push(inode);
  }
  if (unique.length === 0) return out;

  for (let start = 0; start < unique.length; start += PATHS_BATCH_SIZE) {
    const batch = unique.slice(start, start + PATHS_BATCH_SIZE);
    collectBatch(db, batch, out);
  }
  return out;
}

interface SegmentRow {
  target: number;
  link: string;
  depth: number;
  name: string;
  parent_inode: number;
}

function collectBatch(db: Database, batch: number[], out: Map<number, string[]>): void {
  // `link` distinguishes the hardlink names of one target: each seed
  // dirent starts a separate upward walk, and every row on that walk
  // carries its seed's identity so segments regroup correctly. Two
  // hardlinks can share a parent directory ("/one.txt" and "/two.txt"
  // both sit under the root), so the seed's parent inode alone is not
  // a unique key — the seed's (parent_inode, name) pair is.
  const rows = db.all<SegmentRow>(
    `WITH RECURSIVE
       targets(inode) AS (
         SELECT value FROM json_each(?)
       ),
       walk(target, link, depth, name, parent_inode) AS (
         SELECT t.inode, d.parent_inode || '/' || d.name, 0, d.name, d.parent_inode
           FROM targets t
           JOIN vfs_dirents d ON d.child_inode = t.inode
         UNION ALL
         SELECT w.target, w.link, w.depth + 1, d.name, d.parent_inode
           FROM walk w
           JOIN vfs_dirents d ON d.child_inode = w.parent_inode
          WHERE w.parent_inode <> ?
       )
     SELECT target, link, depth, name, parent_inode
       FROM walk
      ORDER BY target, link, depth DESC`,
    JSON.stringify(batch),
    ROOT_INODE,
  );

  // Group by (target, link). Rows arrive root-most segment first, so
  // appending in order builds the path left to right.
  let currentTarget: number | undefined;
  let currentLink: string | undefined;
  let segments: string[] = [];
  let reachedRoot = false;

  const flush = () => {
    if (currentTarget === undefined) return;
    // Only emit paths whose walk actually terminated at the root. A
    // walk that ran out of dirent rows describes an unreachable inode.
    if (reachedRoot && segments.length > 0) {
      const path = `/${segments.join("/")}`;
      const existing = out.get(currentTarget);
      if (existing === undefined) out.set(currentTarget, [path]);
      else existing.push(path);
    }
    segments = [];
    reachedRoot = false;
  };

  for (const row of rows) {
    if (row.target !== currentTarget || row.link !== currentLink) {
      flush();
      currentTarget = row.target;
      currentLink = row.link;
    }
    segments.push(row.name);
    // The deepest row of a completed walk is the one whose parent is
    // the root; depth 0 is the target's own dirent.
    if (row.parent_inode === ROOT_INODE) reachedRoot = true;
  }
  flush();
}
