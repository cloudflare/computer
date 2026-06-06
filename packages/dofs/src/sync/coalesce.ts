import type { Database } from "../storage.js";
import { type ChangeEntry, materialiseChange } from "./changes.js";
import { isIgnored } from "./ignore.js";
import { pathsOf } from "./paths.js";
import { type ChangeCursor, compareChangeCursors } from "./watermarks.js";

// Yield one ChangeEntry per path touched after `after`. Per-path
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
  // Internal snapshot bound. When set, entries are limited to the
  // cursor window `after < entry <= through`. The bound is applied to
  // each path's *live* rev at materialise time, not to a frozen
  // snapshot: a path whose state moves past `through` after the scan
  // (a concurrent rewrite or delete) is dropped here and redelivered
  // under a later cursor, since the cursor never advances past the rev
  // that caused the drop. See the redelivery note on the yield loop.
  through?: ChangeCursor;
}

export async function* coalesceChanges(
  db: Database,
  after: ChangeCursor | number,
  options: CoalesceOptions = {},
): AsyncIterable<ChangeEntry> {
  const ignore = options.ignore ?? [];
  const cursor = typeof after === "number" ? { rev: after, path: null } : after;
  const through = options.through;

  // Build the per-path candidate set in two passes, keeping the
  // highest rev seen for each path. A live mutation that landed
  // after a tombstone wins; a tombstone that landed after a write
  // wins; the highest rev is the rev we stamp on the wire and the
  // rev pullOnce checkpoints to.
  type Candidate = { path: string; rev: number };
  const candidates = new Map<string, Candidate>();

  // Live mutations: every mkdir / writeFile / symlink bumps
  // vfs_nodes.rev. The by_rev index makes this a range scan.
  const lowerRev = cursor.path === null ? cursor.rev : cursor.rev - 1;
  const touched =
    through === undefined
      ? db.all<{ inode: number; rev: number }>(
          "SELECT inode, rev FROM vfs_nodes WHERE rev > ? ORDER BY rev",
          lowerRev,
        )
      : db.all<{ inode: number; rev: number }>(
          "SELECT inode, rev FROM vfs_nodes WHERE rev > ? AND rev <= ? ORDER BY rev",
          lowerRev,
          through.rev,
        );
  for (const { inode, rev } of touched) {
    // One inode can carry several hardlink names; every name has to
    // become a candidate so the wire materialises each, not just the
    // arbitrary one pathOf would return.
    for (const path of pathsOf(db, inode)) {
      if (!inCursorWindow({ rev, path }, cursor, through)) continue;
      if (isIgnored(path, ignore)) continue;
      const prior = candidates.get(path);
      if (prior === undefined || rev > prior.rev) {
        candidates.set(path, { path, rev });
      }
    }
  }

  // Tombstones: each rm appends a row to vfs_changes with the
  // post-bump rev. The highest rev per path wins (a path can be
  // deleted-recreated-deleted; we want the last rm's rev).
  const tombs =
    through === undefined
      ? db.all<{ path: string; rev: number }>(
          "SELECT path, MAX(rev) AS rev FROM vfs_changes WHERE rev > ? AND op = 'delete' GROUP BY path",
          lowerRev,
        )
      : db.all<{ path: string; rev: number }>(
          "SELECT path, MAX(rev) AS rev FROM vfs_changes WHERE rev > ? AND rev <= ? AND op = 'delete' GROUP BY path",
          lowerRev,
          through.rev,
        );
  for (const { path, rev } of tombs) {
    if (!inCursorWindow({ rev, path }, cursor, through)) continue;
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

  // materialiseChange reads each path's *current* state, not the state
  // it held at the candidate's rev — the VFS keeps no content history.
  // If a path was rewritten or deleted again after the scan, its live
  // rev can now sit above `through`; inCursorWindow drops it. The
  // dropped change is not lost: the rev that pushed it past `through`
  // is, by definition, greater than `through.rev` (the cursor the
  // puller persists), so the next pull's `after < entry` scan finds the
  // path again and delivers its then-current state. The consequence is
  // that a `{rev, null}` cursor means "every change committed at or
  // before rev has been *offered*"; it does not guarantee the receiver
  // tree byte-matches the rev snapshot for a path that raced ahead.
  // Convergence is preserved because the cursor never advances past the
  // racing rev. See docs/02_sync_protocol.md.
  for (const { path } of ordered) {
    const entry = materialiseChange(db, path);
    if (entry !== null && inCursorWindow(entry, cursor, through)) {
      yield entry;
    }
  }
}

function inCursorWindow(
  entry: ChangeCursor & { path: string },
  after: ChangeCursor,
  through?: ChangeCursor,
): boolean {
  return (
    compareChangeCursors(entry, after) > 0 &&
    (through === undefined || compareChangeCursors(entry, through) <= 0)
  );
}
