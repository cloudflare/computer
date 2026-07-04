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

// Stable hex key for JS-side membership tests. Only content matters
// here; the SQL match is on the raw hash blob.
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// Largest hash list bound into one IN (…) probe. Comfortably under
// SQLite's bound-parameter limit, so a large probe splits into a few
// index-backed lookups instead of one oversized statement.
const PROBE_BATCH = 256;

// Subset-test the input hashes against vfs_blobs. Symmetric on both
// sides: the DO probes the container before pushObjects, and the
// container probes the DO before fetchObjects, so both sides ship
// only the bytes the receiver lacks.
//
// Matches the raw hash blobs through an IN (…) list so the lookup
// rides the primary-key index. Present hashes are returned in input
// order, preserving any duplicates the caller passed.
export function hasObjects(db: Database, hashes: Uint8Array[]): Uint8Array[] {
  if (hashes.length === 0) return [];
  const present = new Set<string>();
  for (let i = 0; i < hashes.length; i += PROBE_BATCH) {
    const window = hashes.slice(i, i + PROBE_BATCH);
    const placeholders = window.map(() => "?").join(", ");
    const rows = db.all<{ hash: Uint8Array }>(
      `SELECT hash FROM vfs_blobs WHERE hash IN (${placeholders})`,
      ...window,
    );
    for (const row of rows) present.add(toHex(row.hash));
  }
  return hashes.filter((h) => present.has(toHex(h)));
}
