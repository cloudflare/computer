import type { Database } from "../storage.js";
import type { ChangeEntry } from "./changes.js";
import { coalesceChanges } from "./coalesce.js";
import { pushObjects } from "./push.js";
import type { ChangeCursor } from "./watermarks.js";

// The fetch wire is the mirror of the push wire: same SQL,
// opposite direction. The DO calls fetchChanges / fetchObjects on
// the container; the container calls push / pushObjects on the DO.
// Both names exist so call sites read in their own direction.

export function fetchChanges(
  db: Database,
  after: ChangeCursor | number,
  options: { ignore?: string[] } = {},
): AsyncIterable<ChangeEntry> {
  return coalesceChanges(db, after, options);
}

export function fetchObjects(
  db: Database,
  hashes: Uint8Array[],
): AsyncIterable<{ hash: Uint8Array; bytes: Uint8Array }> {
  return pushObjects(db, hashes);
}

// Subset-test the input hashes against vfs_blobs. Symmetric on both
// sides: the DO probes the container before pushObjects, and the
// container probes the DO before fetchObjects, so both sides ship
// only the bytes the receiver lacks.
//
// Single SQL round-trip: bind the hash list to a temp predicate via
// a JOIN on a values() table. The DO SQL flavour doesn't expose
// SQLite carray, so we serialise the input as a JSON array and join
// against json_each.
export function hasObjects(db: Database, hashes: Uint8Array[]): Uint8Array[] {
  if (hashes.length === 0) return [];
  const out: Uint8Array[] = [];
  for (const h of hashes) {
    const row = db.one<{ hash: Uint8Array }>("SELECT hash FROM vfs_blobs WHERE hash = ?", h);
    if (row !== undefined) out.push(row.hash);
  }
  return out;
}
