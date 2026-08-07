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

// Largest hash list bound into one IN (…) probe. Durable Object
// SQLite accepts at most 100 bound parameters per query, so keep
// each probe within that platform limit.
const PROBE_BATCH = 100;

// Subset-test the input hashes against complete local objects. A
// metadata row alone is not enough: the payload must exist and its
// byte length must match the advertised blob size.
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
      `SELECT b.hash
         FROM vfs_blobs b
         JOIN vfs_blob_bytes bb ON bb.hash = b.hash
        WHERE b.hash IN (${placeholders})
          AND length(bb.bytes) = b.size`,
      ...window,
    );
    for (const row of rows) present.add(toHex(row.hash));
  }
  return hashes.filter((h) => present.has(toHex(h)));
}
