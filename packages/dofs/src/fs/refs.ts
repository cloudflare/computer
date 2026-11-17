import { type Database, transactionLocal } from "../storage";
import { evictBlob, hashKey } from "./blobCache";
import { isKeyPinned, type Pin, pinHashes } from "./pins";

// The only place that adds, replaces or drops a file's references to
// chunk blobs (vfs_chunks rows) and to its manifest
// (vfs_nodes.manifest_hash), and the only place that deletes a node
// row. fs/refs.source.test.ts fails the build when such a statement
// appears anywhere else.
//
// Content is shared between files through dedupe and hardlinks, so the
// moment a reference goes is the moment to ask whether anything else
// still uses the content. Every hash a transaction drops becomes a
// candidate. Just before the transaction commits, each candidate that
// nothing references any more is deleted in the same transaction: a
// blob's vfs_blobs and vfs_blob_bytes rows, or a manifest's row. The
// check is one probe of vfs_chunks_by_hash or
// vfs_nodes_by_manifest_hash, and it runs across every inode, so
// content another file or hardlink still uses stays.
//
// A candidate that is pinned (see pins.ts) is deferred instead: held in
// memory and retried at the end of later writes. A candidate dropped by
// a sync apply entry is held by that apply call until it ends; see
// openReapDeferral.
//
// Whatever that misses, the incremental sweep finds: deferred
// candidates lost when the process stopped, staging nothing linked
// (failed streams, abandoned syncs), garbage an older release left, and
// the backlog in stores that predate this. At the end of each write it
// checks the next SWEEP_ROWS_PER_WRITE rows of vfs_blobs or
// vfs_manifests, alternating, after an in-memory rowid cursor that
// wraps at the end. A row goes if nothing references it, nothing pins
// it, and its last_seen is older than SWEEP_GRACE_MS, which covers
// staging still in flight across calls and restarts. A table of N rows
// is covered every 2N / SWEEP_ROWS_PER_WRITE writes, at the cost of
// one short range read per write.

// Deferred candidates retried at the end of each write, so a large
// backlog of released pins drains over several writes instead of
// stalling one.
const DEFERRED_RETRIES_PER_WRITE = 16;

// Candidates an apply call reaps per transaction when it ends.
const HELD_REAPS_PER_TRANSACTION = 100;

// How long an apply call keeps holding what its entries dropped when no
// new entry arrives. A caller that abandons the entry stream never
// reaches close(); after this long its content is no longer held and
// the sweep can take it.
export const APPLY_IDLE_LEASE_MS = 5 * 60 * 1000;

// Rows of one table the sweep checks at the end of each write.
export const SWEEP_ROWS_PER_WRITE = 8;

// Bytes a write may free on behalf of earlier writes, through deferred
// retries and the sweep together: one full chunk. A write always reaps
// what it dropped itself; this only keeps a small save from paying for
// eight 512 KiB blobs someone else left behind.
// The literal is CHUNK_SIZE from writeFile.ts, which imports this module.
export const BACKGROUND_REAP_BYTES_PER_WRITE = 512 * 1024;

// How old an unreferenced row's last_seen must be before the sweep
// takes it. Staging refreshes last_seen, so this is how long staged
// bytes may wait for the link, and matches gc()'s default window.
export const SWEEP_GRACE_MS = 60 * 60 * 1000;

// What one apply call's entries dropped, held until the call ends. The
// pin keeps other writes and the sweep off it in the meantime.
interface ApplyHold {
  blobs: Map<string, DroppedBlob>;
  pin: Pin;
}

// A blob hash with the size of the chunk that pointed at it.
interface DroppedBlob {
  hash: Uint8Array;
  size: number;
}

interface RefState {
  // The apply call whose entry is running right now, if any. Entries
  // apply synchronously, so at most one is running.
  holding: ApplyHold | undefined;
  // Candidates waiting for a pin to go, keyed by hashKey.
  deferredBlobs: Map<string, DroppedBlob>;
  // Sweep position: the last rowid checked in each table, and which
  // table the next write checks.
  sweepBlobsAfter: number;
  sweepManifestsAfter: number;
  sweepManifestsNext: boolean;
}

// What one transaction dropped, keyed by hashKey. Linking a hash
// takes it back off: a rewrite that keeps a chunk drops it and links it
// again, and it is still referenced when the transaction commits
// unless something drops it once more.
interface TransactionRefs {
  droppedBlobs: Map<string, DroppedBlob>;
  droppedManifests: Map<string, Uint8Array>;
}

const states = new WeakMap<Database, RefState>();
const TRANSACTION_KEY = {};

function stateFor(db: Database): RefState {
  let state = states.get(db);
  if (state === undefined) {
    state = {
      holding: undefined,
      deferredBlobs: new Map(),
      sweepBlobsAfter: 0,
      sweepManifestsAfter: 0,
      sweepManifestsNext: false,
    };
    states.set(db, state);
  }
  return state;
}

function transactionRefs(db: Database): TransactionRefs {
  return transactionLocal<TransactionRefs>(
    db,
    TRANSACTION_KEY,
    () => ({ droppedBlobs: new Map(), droppedManifests: new Map() }),
    (refs) => reapDropped(db, refs),
  );
}

// Run `fn` inside a transaction, opening one if the caller has not.
function inTransaction<T>(db: Database, fn: () => T): T {
  return db.inTransaction ? fn() : db.transactionSync(fn);
}

function dropBlob(db: Database, hash: Uint8Array, size: number): void {
  transactionRefs(db).droppedBlobs.set(hashKey(hash), { hash, size });
}

function dropManifest(db: Database, hash: Uint8Array | null): void {
  if (hash !== null) transactionRefs(db).droppedManifests.set(hashKey(hash), hash);
}

function relinkBlob(db: Database, hash: Uint8Array): void {
  transactionRefs(db).droppedBlobs.delete(hashKey(hash));
}

// Runs just before a transaction that touched references commits.
// Manifests are never held: nothing reads a manifest row across an
// await, and linking a file builds its manifest row again.
function reapDropped(db: Database, refs: TransactionRefs): void {
  const state = stateFor(db);
  const hold = state.holding;
  const unpinned: Uint8Array[] = [];
  for (const [key, dropped] of refs.droppedBlobs) {
    if (hold !== undefined) {
      hold.blobs.set(key, dropped);
      hold.pin.add(dropped.hash);
      continue;
    }
    if (isKeyPinned(db, key)) {
      state.deferredBlobs.set(key, dropped);
      continue;
    }
    unpinned.push(dropped.hash);
  }
  reapBlobs(db, unpinned);
  reapManifests(db, [...refs.droppedManifests.values()]);
  const budget = { bytes: BACKGROUND_REAP_BYTES_PER_WRITE };
  retryDeferred(db, state, DEFERRED_RETRIES_PER_WRITE, budget);
  sweepStep(db, state, budget);
}

// Check the next few rows of one table and delete the unreferenced,
// unpinned ones past the grace window. The reference probe runs in the
// same statement, so a write that finds nothing costs one read.
function sweepStep(db: Database, state: RefState, budget: { bytes: number }): void {
  const cutoff = Date.now() - SWEEP_GRACE_MS;
  const manifests = state.sweepManifestsNext;
  state.sweepManifestsNext = !manifests;
  const rows = manifests
    ? db.all<{ id: number; hash: Uint8Array; size: number; orphan: number }>(
        `SELECT rowid AS id, hash, size,
                last_seen < ?
                AND NOT EXISTS (SELECT 1 FROM vfs_nodes n WHERE n.manifest_hash = m.hash) AS orphan
           FROM vfs_manifests m
          WHERE rowid > ?
          ORDER BY rowid
          LIMIT ?`,
        cutoff,
        state.sweepManifestsAfter,
        SWEEP_ROWS_PER_WRITE,
      )
    : db.all<{ id: number; hash: Uint8Array; size: number; orphan: number }>(
        `SELECT rowid AS id, hash, size,
                last_seen < ?
                AND NOT EXISTS (SELECT 1 FROM vfs_chunks c WHERE c.hash = b.hash) AS orphan
           FROM vfs_blobs b
          WHERE rowid > ?
          ORDER BY rowid
          LIMIT ?`,
        cutoff,
        state.sweepBlobsAfter,
        SWEEP_ROWS_PER_WRITE,
      );
  // A short page means the end of the table: start over next time.
  let after = rows.length < SWEEP_ROWS_PER_WRITE ? 0 : rows[rows.length - 1].id;

  // Manifest rows are small and do not count against the byte budget.
  // A blob that would exceed it stops the step, and the cursor stays
  // just before it for the next write.
  const orphans: Uint8Array[] = [];
  for (const [i, row] of rows.entries()) {
    if (row.orphan !== 1) continue;
    if (manifests) {
      orphans.push(row.hash);
      continue;
    }
    const key = hashKey(row.hash);
    if (isKeyPinned(db, key)) continue;
    if (!spend(budget, row.size)) {
      after = i === 0 ? state.sweepBlobsAfter : rows[i - 1].id;
      break;
    }
    state.deferredBlobs.delete(key);
    orphans.push(row.hash);
  }
  if (manifests) state.sweepManifestsAfter = after;
  else state.sweepBlobsAfter = after;
  if (manifests) reapManifests(db, orphans);
  else reapBlobs(db, orphans);
}

// Take `size` bytes from the budget if it has them. The first blob of a
// write always fits, so the budget can never stop progress outright.
function spend(budget: { bytes: number }, size: number): boolean {
  if (size > budget.bytes && budget.bytes < BACKGROUND_REAP_BYTES_PER_WRITE) return false;
  budget.bytes -= size;
  return true;
}

// Retry up to `limit` deferred candidates, oldest first. One still
// pinned goes to the back of the line. Entries leave the set only once
// they are reaped, so a reap that throws, and fails the write with it,
// leaves them for the next write.
function retryDeferred(
  db: Database,
  state: RefState,
  limit: number,
  budget: { bytes: number },
): void {
  const batch = firstEntries(state.deferredBlobs, limit);
  const reaped: Array<[string, DroppedBlob]> = [];
  const stillPinned: Array<[string, DroppedBlob]> = [];
  for (const entry of batch) {
    if (isKeyPinned(db, entry[0])) {
      stillPinned.push(entry);
      continue;
    }
    if (!spend(budget, entry[1].size)) break;
    reaped.push(entry);
  }
  reapBlobs(
    db,
    reaped.map(([, dropped]) => dropped.hash),
  );
  for (const [key] of reaped) state.deferredBlobs.delete(key);
  for (const [key, dropped] of stillPinned) {
    state.deferredBlobs.delete(key);
    state.deferredBlobs.set(key, dropped);
  }
}

function firstEntries<K, V>(map: Map<K, V>, limit: number): Array<[K, V]> {
  const out: Array<[K, V]> = [];
  for (const entry of map) {
    if (out.length >= limit) break;
    out.push(entry);
  }
  return out;
}

// Statements bind at most this many hashes: the Durable Object limit
// on bound parameters (see PROBE_BATCH in sync/fetch.ts).
const REAP_BATCH = 100;

// Batches are padded up to one of these sizes, so only a handful of
// distinct statements reach the prepared-statement cache.
const REAP_BATCH_SIZES = [1, 8, 32, REAP_BATCH];

// Split hashes into statement-sized batches, padding each with copies
// of its last hash up to a fixed size. IN ignores the repeats.
function reapBatches(hashes: Uint8Array[]): Uint8Array[][] {
  const out: Uint8Array[][] = [];
  for (let i = 0; i < hashes.length; i += REAP_BATCH) {
    const batch = hashes.slice(i, i + REAP_BATCH);
    const size = REAP_BATCH_SIZES.find((s) => s >= batch.length) ?? REAP_BATCH;
    while (batch.length < size) batch.push(batch[batch.length - 1]);
    out.push(batch);
  }
  return out;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

// Delete the blobs among `hashes` that no chunk references any more,
// up to REAP_BATCH a statement. vfs_blob_bytes is deleted explicitly
// rather than through its foreign key, which only cascades where
// foreign keys are enforced.
function reapBlobs(db: Database, hashes: Uint8Array[]): void {
  for (const batch of reapBatches(hashes)) {
    const gone = db
      .all<{ hash: Uint8Array }>(
        `DELETE FROM vfs_blobs
          WHERE hash IN (${placeholders(batch.length)})
            AND NOT EXISTS (SELECT 1 FROM vfs_chunks c WHERE c.hash = vfs_blobs.hash)
          RETURNING hash`,
        ...batch,
      )
      .map((row) => row.hash);
    for (const bytesBatch of reapBatches(gone)) {
      db.run(
        `DELETE FROM vfs_blob_bytes WHERE hash IN (${placeholders(bytesBatch.length)})`,
        ...bytesBatch,
      );
    }
    for (const hash of gone) evictBlob(db, hash);
  }
}

function reapManifests(db: Database, hashes: Uint8Array[]): void {
  for (const batch of reapBatches(hashes)) {
    db.run(
      `DELETE FROM vfs_manifests
        WHERE hash IN (${placeholders(batch.length)})
          AND NOT EXISTS (SELECT 1 FROM vfs_nodes n WHERE n.manifest_hash = vfs_manifests.hash)`,
      ...batch,
    );
  }
}

export interface ReapDeferral {
  // Run one entry of the apply. Whatever its transactions drop is held,
  // not reaped, until close().
  hold<T>(step: () => T): T;
  // Reap what the call's entries dropped and nothing links any more.
  // Idempotent, and never throws: a batch that fails to reap goes to the
  // deferred set for later writes to retry.
  close(): void;
}

// Hold off reaping what one sync apply call drops until the call ends.
// Apply runs its entries in separate transactions: a rename arrives as
// a delete of the old path and a file at the new one, so the delete
// drops the last reference to content the next entry links. Only the
// call's own entries are held, each for as long as it runs: other
// writes on the database, including those that run while the call
// awaits its next entry, reap as usual, and the sweep keeps going.
// close() reaps what was held in transactions of a bounded size.
export function openReapDeferral(db: Database): ReapDeferral {
  const state = stateFor(db);
  const held: ApplyHold = {
    blobs: new Map(),
    pin: pinHashes(db, [], { leaseMs: APPLY_IDLE_LEASE_MS }),
  };
  let open = true;
  return {
    hold<T>(step: () => T): T {
      if (!open) return step();
      held.pin.renew();
      const previous = state.holding;
      state.holding = held;
      try {
        return step();
      } finally {
        state.holding = previous;
      }
    },
    close() {
      if (!open) return;
      open = false;
      held.pin.release();
      reapHeld(db, state, held.blobs);
    },
  };
}

function reapHeld(db: Database, state: RefState, blobs: Map<string, DroppedBlob>): void {
  const entries = [...blobs];
  for (let i = 0; i < entries.length; i += HELD_REAPS_PER_TRANSACTION) {
    const batch = entries.slice(i, i + HELD_REAPS_PER_TRANSACTION);
    try {
      inTransaction(db, () => {
        const unpinned: Uint8Array[] = [];
        for (const [key, dropped] of batch) {
          if (isKeyPinned(db, key)) state.deferredBlobs.set(key, dropped);
          else unpinned.push(dropped.hash);
        }
        reapBlobs(db, unpinned);
      });
    } catch {
      for (const [key, dropped] of batch) state.deferredBlobs.set(key, dropped);
    }
  }
}

// True while an apply entry runs inside ReapDeferral.hold.
export function reapsDeferred(db: Database): boolean {
  return states.get(db)?.holding !== undefined;
}

/** @internal Whether a dropped blob is waiting in the deferred set. */
export function isDeferred(db: Database, hash: Uint8Array): boolean {
  return states.get(db)?.deferredBlobs.has(hashKey(hash)) ?? false;
}

export interface FileNodeFields {
  mode: number;
  mtime: number;
  rev: number;
  size: number;
}

// Point chunk `idx` of `inode` at a blob. The index must be free.
export function linkChunk(
  db: Database,
  inode: number,
  idx: number,
  hash: Uint8Array,
  size: number,
): void {
  inTransaction(db, () => {
    db.run(
      "INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
      inode,
      idx,
      hash,
      size,
    );
    relinkBlob(db, hash);
  });
}

// Point chunk `idx` of `inode` at a new blob, replacing whatever was
// there. `previous` is the chunk the caller already loaded for that
// index, or undefined when the index was past the old end of file.
export function replaceChunk(
  db: Database,
  inode: number,
  idx: number,
  hash: Uint8Array,
  size: number,
  previous: { hash: Uint8Array; size: number } | undefined,
): void {
  inTransaction(db, () => {
    db.run(
      "INSERT OR REPLACE INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
      inode,
      idx,
      hash,
      size,
    );
    relinkBlob(db, hash);
    if (previous !== undefined) dropBlob(db, previous.hash, previous.size);
  });
}

// Drop the chunks of `inode` from index `fromIdx` on, and return the
// hashes they pointed at.
export function dropChunks(db: Database, inode: number, fromIdx = 0): Uint8Array[] {
  return inTransaction(db, () => {
    const rows = db.all<{ hash: Uint8Array; size: number }>(
      "DELETE FROM vfs_chunks WHERE inode = ? AND idx >= ? RETURNING hash, size",
      inode,
      fromIdx,
    );
    for (const row of rows) dropBlob(db, row.hash, row.size);
    return rows.map((row) => row.hash);
  });
}

// Write a file node's metadata together with its manifest. A null
// manifest means "not built yet"; sync rebuilds it on demand.
export function setNodeManifest(
  db: Database,
  inode: number,
  manifestHash: Uint8Array | null,
  fields: FileNodeFields,
): void {
  inTransaction(db, () => {
    const previous = db.scalar<Uint8Array | null>(
      "SELECT manifest_hash FROM vfs_nodes WHERE inode = ?",
      inode,
    );
    db.run(
      "UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, size = ?, manifest_hash = ? WHERE inode = ?",
      fields.mode,
      fields.mtime,
      fields.rev,
      fields.size,
      manifestHash,
      inode,
    );
    dropManifest(db, previous ?? null);
    if (manifestHash !== null) transactionRefs(db).droppedManifests.delete(hashKey(manifestHash));
  });
}

// Delete a node row. Its chunks, if it is a file, must be dropped
// first.
export function deleteNode(db: Database, inode: number): void {
  inTransaction(db, () => {
    const row = db.one<{ manifest_hash: Uint8Array | null }>(
      "DELETE FROM vfs_nodes WHERE inode = ? RETURNING manifest_hash",
      inode,
    );
    dropManifest(db, row?.manifest_hash ?? null);
  });
}
