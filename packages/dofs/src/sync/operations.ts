// Durable state for a restartable sync operation.
//
// A `pull()` or `push()` iterable is driven by a JavaScript async
// iterator, and a JavaScript iterator cannot survive Durable Object
// eviction. This module holds everything the iterator would otherwise
// keep in memory: the fixed target it is working toward, the
// generation that fences stale executions, the block sizing profile,
// and a marker for the block currently in flight.
//
// The committed progress cursor is not here. That stays in
// `_vfs_watermark` (see watermarks.ts) because filesystem application
// and cursor advancement must commit in the same storage transaction.
// This table records where an operation is *going*; the watermark
// records how far it has *got*.
//
// Every mutation is conditional on the generation. That is what makes
// a late write from a superseded execution a no-op rather than a
// corruption: the `WHERE generation = ?` clause fails and the caller
// learns it lost the race from the returned boolean.

import type { Database } from "../storage.js";
import { type ChangeCursor, DEFAULT_BACKEND_ID } from "./watermarks.js";

export type SyncDirection = "pull" | "push";
export type SyncMode = "entries" | "pack";
export type SyncOperationStatus = "capturing" | "pending" | "failed" | "lost";

// Terminal statuses. A row in one of these states is diagnostic
// history: it no longer describes work in progress, and the next
// caller replaces it with a new generation.
export type TerminalStatus = "failed" | "lost";

// Internal block sizing. Not part of any public API — the plan is
// explicit that callers never supply budgets. The profile is persisted
// per operation so an in-flight operation keeps the sizing it started
// with even if the constants change under it.
export interface BlockProfile {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export const DEFAULT_BLOCK_PROFILE: BlockProfile = {
  maxEntries: 4_000,
  maxBytes: 64 * 1024 * 1024,
};

// Floor for automatic shrinking. Halving without a floor walks to
// zero and an operation that can carry no entries makes no progress.
export const MIN_BLOCK_PROFILE: BlockProfile = {
  maxEntries: 500,
  maxBytes: 8 * 1024 * 1024,
};

export interface SyncOperation {
  readonly backend: string;
  readonly direction: SyncDirection;
  readonly generation: string;
  readonly status: SyncOperationStatus;
  // Absent exactly while status is 'capturing'.
  readonly target?: ChangeCursor;
  readonly mode?: SyncMode;
  readonly runtimeId?: string;
  // Where the in-flight block started. Present means a block was
  // opened and has not yet advanced the cursor.
  readonly blockAfter?: ChangeCursor;
  readonly blockStartedAt?: number;
  readonly profile: BlockProfile;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastError?: string;
}

export interface SyncSkip {
  readonly generation: string;
  readonly path: string;
  readonly reason: string;
  readonly at: number;
}

interface OperationRow {
  backend: string;
  direction: SyncDirection;
  generation: string;
  status: SyncOperationStatus;
  target_rev: number | null;
  target_path: string | null;
  runtime_id: string | null;
  mode: SyncMode | null;
  block_after_rev: number | null;
  block_after_path: string | null;
  block_started_at: number | null;
  internal_max_entries: number;
  internal_max_bytes: number;
  created_at: number;
  updated_at: number;
  last_error: string | null;
}

// A target of `{rev, path: null}` means the rev is fully drained;
// a string path (including the empty string, which is a real path
// value) means resume inside that rev. Both survive the round trip
// because rev and path are stored in separate columns — encoding them
// into one string would make the empty path ambiguous.
function rowToOperation(row: OperationRow): SyncOperation {
  const operation: {
    -readonly [K in keyof SyncOperation]: SyncOperation[K];
  } = {
    backend: row.backend,
    direction: row.direction,
    generation: row.generation,
    status: row.status,
    profile: {
      maxEntries: row.internal_max_entries,
      maxBytes: row.internal_max_bytes,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.target_rev !== null) {
    operation.target = { rev: row.target_rev, path: row.target_path };
  }
  if (row.mode !== null) operation.mode = row.mode;
  if (row.runtime_id !== null) operation.runtimeId = row.runtime_id;
  if (row.block_after_rev !== null) {
    operation.blockAfter = { rev: row.block_after_rev, path: row.block_after_path };
  }
  if (row.block_started_at !== null) operation.blockStartedAt = row.block_started_at;
  if (row.last_error !== null) operation.lastError = row.last_error;
  return operation;
}

export function readOperation(
  db: Database,
  backend: string = DEFAULT_BACKEND_ID,
  direction: SyncDirection = "pull",
): SyncOperation | undefined {
  const row = db.one<OperationRow>(
    "SELECT * FROM _vfs_sync_operations WHERE backend = ? AND direction = ?",
    backend,
    direction,
  );
  return row === undefined ? undefined : rowToOperation(row);
}

// Generations only need to be unique per (backend, direction) and
// unguessable enough that a stale execution cannot collide with its
// replacement. crypto.randomUUID is available in workerd and Node.
function newGeneration(): string {
  return crypto.randomUUID();
}

// Phase one of target capture: claim the slot before talking to the
// remote. Overwrites any existing row, including a 'capturing' row
// left behind by an evicted iterator and a terminal 'failed' or 'lost'
// row, because in every one of those cases the prior execution no
// longer owns the operation. Taking a fresh generation is what
// invalidates it.
export function beginCapture(
  db: Database,
  backend: string = DEFAULT_BACKEND_ID,
  direction: SyncDirection = "pull",
  now: number = Date.now(),
): string {
  const generation = newGeneration();
  db.run(
    `INSERT INTO _vfs_sync_operations (
       backend, direction, generation, status,
       internal_max_entries, internal_max_bytes,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'capturing', ?, ?, ?, ?)
     ON CONFLICT(backend, direction) DO UPDATE SET
       generation = excluded.generation,
       status = 'capturing',
       target_rev = NULL,
       target_path = NULL,
       runtime_id = NULL,
       mode = NULL,
       block_after_rev = NULL,
       block_after_path = NULL,
       block_started_at = NULL,
       internal_max_entries = excluded.internal_max_entries,
       internal_max_bytes = excluded.internal_max_bytes,
       updated_at = excluded.updated_at,
       last_error = NULL`,
    backend,
    direction,
    generation,
    DEFAULT_BLOCK_PROFILE.maxEntries,
    DEFAULT_BLOCK_PROFILE.maxBytes,
    now,
    now,
  );
  return generation;
}

// Phase two: the remote target has been read, so freeze it. Returns
// false when this generation no longer owns the operation, which is
// the case an evicted-and-restarted capture must handle — the target
// it captured is discarded rather than overwriting the replacement's.
export function fixTarget(
  db: Database,
  backend: string,
  direction: SyncDirection,
  generation: string,
  input: { target: ChangeCursor; mode: SyncMode; runtimeId?: string },
  now: number = Date.now(),
): boolean {
  db.run(
    `UPDATE _vfs_sync_operations
        SET status = 'pending',
            target_rev = ?,
            target_path = ?,
            mode = ?,
            runtime_id = ?,
            updated_at = ?
      WHERE backend = ? AND direction = ? AND generation = ? AND status = 'capturing'`,
    input.target.rev,
    input.target.path,
    input.mode,
    input.runtimeId ?? null,
    now,
    backend,
    direction,
    generation,
  );
  const current = readOperation(db, backend, direction);
  return current?.generation === generation && current.status === "pending";
}

export interface OpenedOperation {
  readonly operation: SyncOperation;
  // True when this caller attached to an operation someone else
  // created. A joining caller must not capture a new target; the
  // target is already fixed and shared.
  readonly joined: boolean;
}

// Read-or-create in one step. A pending operation is joined so
// concurrent callers converge on one target instead of racing to
// create competing ones. A terminal row is replaced.
//
// A 'capturing' row is *not* joined: it has no target, so there is
// nothing to share, and the execution that created it may be gone.
// Taking it over with a new generation is the recovery path for an
// eviction during capture.
export function openOperation(
  db: Database,
  backend: string = DEFAULT_BACKEND_ID,
  direction: SyncDirection = "pull",
  now: number = Date.now(),
): OpenedOperation {
  return db.transactionSync(() => {
    const existing = readOperation(db, backend, direction);
    if (existing !== undefined && existing.status === "pending") {
      return { operation: existing, joined: true };
    }
    const generation = beginCapture(db, backend, direction, now);
    const operation = readOperation(db, backend, direction);
    if (operation === undefined) {
      throw new Error("dofs sync: operation row vanished immediately after capture");
    }
    if (operation.generation !== generation) {
      throw new Error("dofs sync: operation generation changed inside its own transaction");
    }
    return { operation, joined: false };
  });
}

// Completion deletes the row. The backend watermark is the durable
// record that the work happened, so keeping a completed operation
// would duplicate it — and a stale 'complete' row is exactly what
// would make the next caller think there is nothing to do.
//
// Deleting also resets the block profile, because the next operation's
// beginCapture writes DEFAULT_BLOCK_PROFILE. That is deliberate: a
// profile shrunk by one bad block must not follow a workspace forever.
export function completeOperation(
  db: Database,
  backend: string,
  direction: SyncDirection,
  generation: string,
): boolean {
  const existing = readOperation(db, backend, direction);
  if (existing?.generation !== generation) return false;
  db.run(
    "DELETE FROM _vfs_sync_operations WHERE backend = ? AND direction = ? AND generation = ?",
    backend,
    direction,
    generation,
  );
  return true;
}

// Terminal failure. The row is retained with its error so an operator
// can see why a backend stopped converging; the next caller replaces
// it. `lost` specifically means the runtime the operation was fenced
// to no longer exists, which is not retryable against the same target.
export function failOperation(
  db: Database,
  backend: string,
  direction: SyncDirection,
  generation: string,
  status: TerminalStatus,
  error: string,
  now: number = Date.now(),
): boolean {
  const existing = readOperation(db, backend, direction);
  if (existing?.generation !== generation) return false;
  db.run(
    `UPDATE _vfs_sync_operations
        SET status = ?, last_error = ?, updated_at = ?
      WHERE backend = ? AND direction = ? AND generation = ?`,
    status,
    error,
    now,
    backend,
    direction,
    generation,
  );
  return true;
}

// Persisted before a block stream opens. If a later invocation finds
// this marker still set and the watermark has not moved, the previous
// execution died mid-block and the profile should shrink.
export function markBlockStarted(
  db: Database,
  backend: string,
  direction: SyncDirection,
  generation: string,
  after: ChangeCursor,
  now: number = Date.now(),
): boolean {
  const existing = readOperation(db, backend, direction);
  if (existing?.generation !== generation) return false;
  db.run(
    `UPDATE _vfs_sync_operations
        SET block_after_rev = ?, block_after_path = ?, block_started_at = ?, updated_at = ?
      WHERE backend = ? AND direction = ? AND generation = ?`,
    after.rev,
    after.path,
    now,
    now,
    backend,
    direction,
    generation,
  );
  return true;
}

// Cleared only after the cursor has advanced past the block. Clearing
// earlier would lose the interruption signal.
export function clearBlockMarker(
  db: Database,
  backend: string,
  direction: SyncDirection,
  generation: string,
  now: number = Date.now(),
): boolean {
  const existing = readOperation(db, backend, direction);
  if (existing?.generation !== generation) return false;
  db.run(
    `UPDATE _vfs_sync_operations
        SET block_after_rev = NULL, block_after_path = NULL,
            block_started_at = NULL, updated_at = ?
      WHERE backend = ? AND direction = ? AND generation = ?`,
    now,
    backend,
    direction,
    generation,
  );
  return true;
}

// Halve the profile, floored at MIN_BLOCK_PROFILE. Called when a block
// marker survived without cursor progress, meaning the last attempt at
// this size did not fit in the available CPU.
export function shrinkBlockProfile(
  db: Database,
  backend: string,
  direction: SyncDirection,
  generation: string,
  now: number = Date.now(),
): BlockProfile | undefined {
  const existing = readOperation(db, backend, direction);
  if (existing?.generation !== generation) return undefined;
  const next: BlockProfile = {
    maxEntries: Math.max(MIN_BLOCK_PROFILE.maxEntries, Math.floor(existing.profile.maxEntries / 2)),
    maxBytes: Math.max(MIN_BLOCK_PROFILE.maxBytes, Math.floor(existing.profile.maxBytes / 2)),
  };
  db.run(
    `UPDATE _vfs_sync_operations
        SET internal_max_entries = ?, internal_max_bytes = ?, updated_at = ?
      WHERE backend = ? AND direction = ? AND generation = ?`,
    next.maxEntries,
    next.maxBytes,
    now,
    backend,
    direction,
    generation,
  );
  return next;
}

// Durable record of an entry the receiver refused. Keyed by generation
// so a caller can tell which operation dropped what, and idempotent on
// replay because the same path rejected twice in one generation is one
// fact, not two.
export function recordSkip(
  db: Database,
  backend: string,
  direction: SyncDirection,
  generation: string,
  path: string,
  reason: string,
  now: number = Date.now(),
): void {
  db.run(
    `INSERT INTO _vfs_sync_skips (backend, direction, generation, path, reason, at)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(backend, direction, generation, path) DO UPDATE SET
       reason = excluded.reason, at = excluded.at`,
    backend,
    direction,
    generation,
    path,
    reason,
    now,
  );
}

export function readSkips(
  db: Database,
  backend: string = DEFAULT_BACKEND_ID,
  direction: SyncDirection = "pull",
): SyncSkip[] {
  return db
    .all<{ generation: string; path: string; reason: string; at: number }>(
      `SELECT generation, path, reason, at
         FROM _vfs_sync_skips
        WHERE backend = ? AND direction = ?
        ORDER BY at, path`,
      backend,
      direction,
    )
    .map((row) => ({
      generation: row.generation,
      path: row.path,
      reason: row.reason,
      at: row.at,
    }));
}

// Drop skips that belong to any generation other than the current one.
// Called when a new operation starts so the log describes the latest
// attempt rather than growing without bound.
export function pruneSkips(
  db: Database,
  backend: string,
  direction: SyncDirection,
  generation: string,
): void {
  db.run(
    "DELETE FROM _vfs_sync_skips WHERE backend = ? AND direction = ? AND generation != ?",
    backend,
    direction,
    generation,
  );
}
