import type { Database } from "../storage";
import { evictBlob, hashKey } from "./blobCache";
import { isKeyPinned } from "./pins";

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
// A candidate that is pinned (see pins.ts), or dropped while a reap
// deferral is open, is deferred instead: held in memory and retried at
// the end of later writes.
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

// Rows of one table the sweep checks at the end of each write.
export const SWEEP_ROWS_PER_WRITE = 8;

// How old an unreferenced row's last_seen must be before the sweep
// takes it. Staging refreshes last_seen, so this is how long staged
// bytes may wait for the link, and matches gc()'s default window.
export const SWEEP_GRACE_MS = 60 * 60 * 1000;

interface RefState {
  // Open reap deferral scopes. See openReapDeferral.
  deferDepth: number;
  // Candidates waiting for a pin to go or a deferral to close, keyed by
  // hashKey.
  deferredBlobs: Map<string, Uint8Array>;
  deferredManifests: Map<string, Uint8Array>;
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
  droppedBlobs: Map<string, Uint8Array>;
  droppedManifests: Map<string, Uint8Array>;
}

const states = new WeakMap<Database, RefState>();
const TRANSACTION_KEY = {};

function stateFor(db: Database): RefState {
  let state = states.get(db);
  if (state === undefined) {
    state = {
      deferDepth: 0,
      deferredBlobs: new Map(),
      deferredManifests: new Map(),
      sweepBlobsAfter: 0,
      sweepManifestsAfter: 0,
      sweepManifestsNext: false,
    };
    states.set(db, state);
  }
  return state;
}

function transactionRefs(db: Database): TransactionRefs {
  return db.transactionLocal<TransactionRefs>(
    TRANSACTION_KEY,
    () => ({ droppedBlobs: new Map(), droppedManifests: new Map() }),
    (refs) => settle(db, refs),
  );
}

// Run `fn` inside a transaction, opening one if the caller has not.
function inTransaction<T>(db: Database, fn: () => T): T {
  return db.inTransaction ? fn() : db.transactionSync(fn);
}

function dropBlob(db: Database, hash: Uint8Array): void {
  transactionRefs(db).droppedBlobs.set(hashKey(hash), hash);
}

function dropManifest(db: Database, hash: Uint8Array | null): void {
  if (hash !== null) transactionRefs(db).droppedManifests.set(hashKey(hash), hash);
}

function relinkBlob(db: Database, hash: Uint8Array): void {
  transactionRefs(db).droppedBlobs.delete(hashKey(hash));
}

// Runs just before a transaction that touched references commits.
function settle(db: Database, refs: TransactionRefs): void {
  const state = stateFor(db);
  const deferring = state.deferDepth > 0;
  for (const [key, hash] of refs.droppedBlobs) {
    if (deferring || isKeyPinned(db, key)) {
      state.deferredBlobs.set(key, hash);
      continue;
    }
    reapBlob(db, hash);
  }
  for (const [key, hash] of refs.droppedManifests) {
    if (deferring) {
      state.deferredManifests.set(key, hash);
      continue;
    }
    reapManifest(db, hash);
  }
  if (deferring) return;
  retryDeferred(db, state, DEFERRED_RETRIES_PER_WRITE);
  sweepStep(db, state);
}

// Check the next few rows of one table and delete the unreferenced,
// unpinned ones past the grace window. The reference probe runs in the
// same statement, so a write that finds nothing costs one read.
function sweepStep(db: Database, state: RefState): void {
  const cutoff = Date.now() - SWEEP_GRACE_MS;
  const manifests = state.sweepManifestsNext;
  state.sweepManifestsNext = !manifests;
  const rows = manifests
    ? db.all<{ id: number; hash: Uint8Array; orphan: number }>(
        `SELECT rowid AS id, hash,
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
    : db.all<{ id: number; hash: Uint8Array; orphan: number }>(
        `SELECT rowid AS id, hash,
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
  const after = rows.length < SWEEP_ROWS_PER_WRITE ? 0 : rows[rows.length - 1].id;
  if (manifests) state.sweepManifestsAfter = after;
  else state.sweepBlobsAfter = after;

  for (const row of rows) {
    if (row.orphan !== 1) continue;
    const key = hashKey(row.hash);
    if (manifests) {
      state.deferredManifests.delete(key);
      reapManifest(db, row.hash);
      continue;
    }
    if (isKeyPinned(db, key)) continue;
    state.deferredBlobs.delete(key);
    reapBlob(db, row.hash);
  }
}

// Retry up to `limit` deferred candidates of each kind, oldest first.
// One still pinned goes to the back of the line.
function retryDeferred(db: Database, state: RefState, limit: number): void {
  for (const [key, hash] of firstEntries(state.deferredBlobs, limit)) {
    state.deferredBlobs.delete(key);
    if (isKeyPinned(db, key)) {
      state.deferredBlobs.set(key, hash);
      continue;
    }
    reapBlob(db, hash);
  }
  for (const [key, hash] of firstEntries(state.deferredManifests, limit)) {
    state.deferredManifests.delete(key);
    reapManifest(db, hash);
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

// Delete a blob that no chunk references any more. vfs_blob_bytes is
// deleted explicitly rather than through its foreign key, which only
// cascades where foreign keys are enforced.
function reapBlob(db: Database, hash: Uint8Array): void {
  const gone = db.one(
    `DELETE FROM vfs_blobs
      WHERE hash = ?
        AND NOT EXISTS (SELECT 1 FROM vfs_chunks WHERE hash = ?)
      RETURNING hash`,
    hash,
    hash,
  );
  if (gone === undefined) return;
  db.run("DELETE FROM vfs_blob_bytes WHERE hash = ?", hash);
  evictBlob(db, hash);
}

function reapManifest(db: Database, hash: Uint8Array): void {
  db.run(
    `DELETE FROM vfs_manifests
      WHERE hash = ?
        AND NOT EXISTS (SELECT 1 FROM vfs_nodes WHERE manifest_hash = ?)`,
    hash,
    hash,
  );
}

// Hold off reclaiming content until close(). Sync apply removes and
// links in separate transactions: a rename arrives as a delete of the
// old path and a file at the new one, so the delete drops the last
// reference to content the next entry links. Inside the scope every
// candidate is deferred, and close() on the last open scope retries
// them all.
export function openReapDeferral(db: Database): { close(): void } {
  const state = stateFor(db);
  state.deferDepth++;
  let open = true;
  return {
    close() {
      if (!open) return;
      open = false;
      state.deferDepth--;
      if (state.deferDepth > 0) return;
      const pending = state.deferredBlobs.size + state.deferredManifests.size;
      if (pending === 0) return;
      inTransaction(db, () => retryDeferred(db, state, pending));
    },
  };
}

export function reapsDeferred(db: Database): boolean {
  return (states.get(db)?.deferDepth ?? 0) > 0;
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
// there. `previous` is the hash the caller already loaded for that
// index, or undefined when the index was past the old end of file.
export function replaceChunk(
  db: Database,
  inode: number,
  idx: number,
  hash: Uint8Array,
  size: number,
  previous: Uint8Array | undefined,
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
    if (previous !== undefined) dropBlob(db, previous);
  });
}

// Drop the chunks of `inode` from index `fromIdx` on, and return the
// hashes they pointed at.
export function dropChunks(db: Database, inode: number, fromIdx = 0): Uint8Array[] {
  return inTransaction(db, () => {
    const hashes = db
      .all<{ hash: Uint8Array }>(
        "DELETE FROM vfs_chunks WHERE inode = ? AND idx >= ? RETURNING hash",
        inode,
        fromIdx,
      )
      .map((row) => row.hash);
    for (const hash of hashes) dropBlob(db, hash);
    return hashes;
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
