import type { Database } from "./storage.js";

// Atomic monotonic rev counter. Every FS mutation (mkdir, writeFile,
// rm, ...) calls incrementRev once per transaction and stamps the returned
// value into vfs_nodes.rev. The sync layer reads vfs_meta.rev as
// currentRev and consumes vfs_changes.rev for tombstones.
//
// Must be called inside a transactionSync — the UPDATE and SELECT
// otherwise race with concurrent mutations. The DO single-writer model
// makes that unlikely in practice, but the contract is "wrap me".
export function incrementRev(db: Database): number {
  // RETURNING folds the read into the same statement so each mutation
  // pays one round-trip instead of two. SQLite has supported it since
  // 3.35; both node:sqlite and Cloudflare DO SqlStorage are on newer
  // versions.
  const row = db.one<{ v: number }>("UPDATE vfs_meta SET v = v + 1 WHERE k = 'rev' RETURNING v");
  if (row === undefined) {
    throw new Error("vfs_meta.rev row missing; was initializeSchema run?");
  }
  return row.v;
}
