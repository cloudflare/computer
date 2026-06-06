import type { Database } from "../storage.js";
import { type ChangeEntry, materialiseChange } from "./changes.js";
import { isIgnored } from "./ignore.js";
import { pathOf } from "./paths.js";

// Yield one ChangeEntry per path touched since `sinceRev`. Per-path
// coalescing: five rewrites of the same path between watermarks
// produce one entry (the latest state wins). Tombstoned paths get a
// delete entry unless they have been recreated, in which case the
// live entry wins.
//
// Entries are emitted in ascending rev order. pullOnce relies on
// this so it can advance fetchRev per committed batch — if entry N
// has rev R, every entry already emitted has rev <= R, so
// checkpointing fetchRev at R is safe.
//
// Streaming, not buffering at the wire: the per-path coalesce step
// holds at most one slot per dirty path in memory (sorted by rev),
// which is the same bound the live + tombstone scans already pay.
export interface CoalesceOptions {
  // Path-segment patterns to drop before yielding. The wire never
  // carries entries under an ignored segment.
  ignore?: string[];
}

export async function* coalesceChanges(
  db: Database,
  sinceRev: number,
  options: CoalesceOptions = {},
): AsyncIterable<ChangeEntry> {
  const ignore = options.ignore ?? [];

  // Build the per-path candidate set in two passes, keeping the
  // highest rev seen for each path. A live mutation that landed
  // after a tombstone wins; a tombstone that landed after a write
  // wins; the highest rev is the rev we stamp on the wire and the
  // rev pullOnce checkpoints to.
  type Candidate = { path: string; rev: number };
  const candidates = new Map<string, Candidate>();

  // Live mutations: every mkdir / writeFile / symlink bumps
  // vfs_nodes.rev. The by_rev index makes this a range scan.
  const touched = db.all<{ inode: number; rev: number }>(
    "SELECT inode, rev FROM vfs_nodes WHERE rev > ? ORDER BY rev",
    sinceRev,
  );
  for (const { inode, rev } of touched) {
    const path = pathOf(db, inode);
    if (path === null) continue;
    if (isIgnored(path, ignore)) continue;
    const prior = candidates.get(path);
    if (prior === undefined || rev > prior.rev) {
      candidates.set(path, { path, rev });
    }
  }

  // Tombstones: each rm appends a row to vfs_changes with the
  // post-bump rev. The highest rev per path wins (a path can be
  // deleted-recreated-deleted; we want the last rm's rev).
  const tombs = db.all<{ path: string; rev: number }>(
    "SELECT path, MAX(rev) AS rev FROM vfs_changes WHERE rev > ? AND op = 'delete' GROUP BY path",
    sinceRev,
  );
  for (const { path, rev } of tombs) {
    if (isIgnored(path, ignore)) continue;
    const prior = candidates.get(path);
    if (prior === undefined || rev > prior.rev) {
      candidates.set(path, { path, rev });
    }
  }

  // Sort by rev ascending so pullOnce can checkpoint per batch.
  // Ties on rev (same transactionSync touching multiple paths)
  // break on path so the wire order is deterministic.
  const ordered = Array.from(candidates.values()).sort((a, b) => {
    if (a.rev !== b.rev) return a.rev - b.rev;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  for (const { path } of ordered) {
    const entry = materialiseChange(db, path);
    if (entry !== null) yield entry;
  }
}
