import type { Database } from "../storage.js";

// Watermarks owned by the local database. Keyed by (k, backend) so a
// single workspace can host more than one backend and each keeps its
// own sync cursors. The container's appliedPushRev lives in-memory on
// the container side; we don't store it here.
//
// pushRev   — last DO-side rev successfully pushed to the backend.
// fetchRev  — last backend-side rev the DO has fetched and applied.
//
// initializeSchema() seeds both at 0 in _vfs_watermark for the
// default backend. The schema table is the durability surface;
// readers and writers always go through this module so the SQL
// stays in one place.
//
// `backend` defaults to DEFAULT_BACKEND_ID so older callers that
// only ran one backend (or ran the package against a schema before
// per-backend keying landed) keep working unchanged. The v2 → v3
// schema migration backfills the column on existing rows with the
// same default.
export type WatermarkKey = "pushRev" | "fetchRev";

export const DEFAULT_BACKEND_ID = "default";

// Cursor into the remote change stream. `path: null` means `rev`
// is fully drained and the next fetch resumes strictly after that
// rev. A string path means resume inside the same rev after that
// path. The empty string is a real path value, not a sentinel, and
// must not be used to mean "start of rev".
export type ChangeCursor = { rev: number; path: string | null };

export function readWatermark(
  db: Database,
  key: WatermarkKey,
  backend: string = DEFAULT_BACKEND_ID,
): number {
  return (
    db.scalar<number>("SELECT v FROM _vfs_watermark WHERE k = ? AND backend = ?", key, backend) ?? 0
  );
}

function writeWatermarkValue(
  db: Database,
  key: WatermarkKey,
  value: number,
  backend: string = DEFAULT_BACKEND_ID,
): void {
  db.run(
    "INSERT INTO _vfs_watermark (k, backend, v) VALUES (?, ?, ?) " +
      "ON CONFLICT(k, backend) DO UPDATE SET v = excluded.v",
    key,
    backend,
    value,
  );
}

function writeFetchCursorPath(
  db: Database,
  path: string | null,
  backend: string = DEFAULT_BACKEND_ID,
): void {
  db.run(
    "INSERT INTO _vfs_fetch_cursor (k, backend, path) VALUES (?, ?, ?) " +
      "ON CONFLICT(k, backend) DO UPDATE SET path = excluded.path",
    "fetch",
    backend,
    path,
  );
}

export function writeWatermark(
  db: Database,
  key: WatermarkKey,
  value: number,
  backend: string = DEFAULT_BACKEND_ID,
): void {
  if (key !== "fetchRev") {
    writeWatermarkValue(db, key, value, backend);
    return;
  }

  db.transactionSync(() => {
    writeWatermarkValue(db, key, value, backend);
    writeFetchCursorPath(db, null, backend);
  });
}

export function readFetchCursor(db: Database, backend: string = DEFAULT_BACKEND_ID): ChangeCursor {
  const rev = readWatermark(db, "fetchRev", backend);
  if (rev === 0) return { rev: 0, path: null };
  const path = db.scalar<string | null>(
    "SELECT path FROM _vfs_fetch_cursor WHERE k = ? AND backend = ?",
    "fetch",
    backend,
  );
  return { rev, path: path ?? null };
}

export function writeFetchCursor(
  db: Database,
  cursor: ChangeCursor,
  backend: string = DEFAULT_BACKEND_ID,
): void {
  db.transactionSync(() => {
    writeWatermarkValue(db, "fetchRev", cursor.rev, backend);
    writeFetchCursorPath(db, cursor.path, backend);
  });
}

export function compareChangeCursors(a: ChangeCursor, b: ChangeCursor): number {
  if (a.rev !== b.rev) return a.rev - b.rev;
  if (a.path === b.path) return 0;
  if (a.path === null) return 1;
  if (b.path === null) return -1;
  return a.path < b.path ? -1 : 1;
}

// The latest rev stamped on any DO-side mutation. coalesceChanges
// reads this implicitly via vfs_nodes.rev; the sync layer exposes it
// to callers that want to record the rev component of their next
// cursor.
export function currentRev(db: Database): number {
  return db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;
}
