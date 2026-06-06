// Sync-protocol tables. Populated by the sync module; the FS module
// only writes to vfs_changes (via sync/changes.ts) on rm. The rest
// of these tables stay empty until the sync task is implemented.

export const SYNC_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS vfs_manifests (
    hash      BLOB    PRIMARY KEY,
    size      INTEGER NOT NULL,
    encoded   BLOB    NOT NULL,
    last_seen INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS vfs_changes (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    rev  INTEGER NOT NULL,
    path TEXT    NOT NULL,
    op   TEXT    NOT NULL CHECK(op IN ('delete'))
  )`,
  `CREATE INDEX IF NOT EXISTS vfs_changes_by_rev ON vfs_changes(rev)`,
  // changes.ts looks up the latest op for a path via
  // `WHERE path = ? ORDER BY id DESC LIMIT 1`. Without the index
  // SQLite falls back to a full scan; with (path, id DESC) the
  // lookup is O(log n) and the ORDER BY drains straight from the
  // index. Used on every recordDelete and on every push-tick that
  // processes tombstones.
  `CREATE INDEX IF NOT EXISTS vfs_changes_by_path ON vfs_changes(path, id DESC)`,
  // Watermarks are keyed by (k, backend) so a workspace hosting
  // multiple backends keeps each backend's sync cursors
  // independent. The `backend` column was added at schema v3;
  // `schema/migrations.ts` owns the ALTER for existing
  // databases. Fresh installs land the composite key directly.
  `CREATE TABLE IF NOT EXISTS _vfs_watermark (
    k       TEXT    NOT NULL,
    backend TEXT    NOT NULL DEFAULT 'default',
    v       INTEGER NOT NULL,
    PRIMARY KEY (k, backend)
  )`,
  // The fetch cursor's same-rev `path` component, keyed by
  // (k, backend) so each backend resumes a partially-drained rev
  // independently. The rev component lives in _vfs_watermark under
  // 'fetchRev'; this table only holds the in-rev path. `backend`
  // mirrors _vfs_watermark and defaults to 'default'.
  `CREATE TABLE IF NOT EXISTS _vfs_fetch_cursor (
    k       TEXT    NOT NULL CHECK(k = 'fetch'),
    backend TEXT    NOT NULL DEFAULT 'default',
    path    TEXT,
    PRIMARY KEY (k, backend)
  )`,
  // The `mode` column was added at schema v2; `schema/migrations.ts`
  // owns the ALTER for existing databases. Keep the CHECK
  // constraint here aligned with the migration's CHECK so fresh
  // installs and upgrades enforce the same allowed set.
  `CREATE TABLE IF NOT EXISTS _vfs_mounts (
    root    TEXT PRIMARY KEY,
    kind    TEXT NOT NULL,
    indexed INTEGER NOT NULL DEFAULT 0,
    mode    TEXT NOT NULL DEFAULT 'read-only'
            CHECK(mode IN ('read-only', 'read-write'))
  )`,
] as const;
