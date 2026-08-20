// Schema migration runner.
//
// The schema's "CREATE TABLE IF NOT EXISTS" baseline handles fresh
// databases. When a schema column changes shape — added, dropped,
// renamed, retyped — IF NOT EXISTS does nothing and the older
// rows stay incompatible. Migrations close that gap.
//
// Shape: an ordered list of `(from, to, migrator)` tuples. The
// runner reads `vfs_meta.schema_version` (defaulting to 0 when the
// row is absent), picks every migration whose `from === current`,
// runs it, advances `current`, and repeats until `current >=
// SCHEMA_VERSION`. The whole pass runs inside the caller's
// transactionSync so a partial migration rolls back.
//
// Each migrator is a `(db: Database) => void` and may assume the
// previous version's schema is in place. Migrators land schema
// changes only; they don't touch user data unless the column shape
// requires it.

import type { Database } from "../storage.js";

export interface Migration {
  readonly from: number;
  readonly to: number;
  readonly migrator: (db: Database) => void;
}

// v1 → v2 — add `_vfs_mounts.mode` so dofs can enforce read-only
// mounts at the data layer. Existing rows default to 'read-only';
// the workspace re-stamps them with the registered mount's mode on
// the next index pass.
//
// The CHECK constraint is duplicated in `sync.ts`'s fresh-install
// DDL; both paths must keep the same allowed set.
function v1_to_v2_add_mounts_mode(db: Database): void {
  db.run(
    `ALTER TABLE _vfs_mounts
       ADD COLUMN mode TEXT NOT NULL DEFAULT 'read-only'
       CHECK(mode IN ('read-only', 'read-write'))`,
  );
}

// v2 → v3 — denormalise file size onto vfs_nodes so stat doesn't
// have to SUM the chunk rows on every call. The column is
// backfilled from existing vfs_chunks; later writes maintain it.
function v2_to_v3_add_size_column(db: Database): void {
  const hasColumn = db
    .all<{ name: string }>("PRAGMA table_info(vfs_nodes)")
    .some((column) => column.name === "size");
  if (!hasColumn) {
    db.run("ALTER TABLE vfs_nodes ADD COLUMN size INTEGER NOT NULL DEFAULT 0");
  }
  db.run(
    `UPDATE vfs_nodes
        SET size = COALESCE(
          (SELECT SUM(size) FROM vfs_chunks WHERE vfs_chunks.inode = vfs_nodes.inode),
          0
        )
      WHERE type = 'file'`,
  );
}

// v3 → v4 — add a `backend` column to `_vfs_watermark` so a
// workspace can host more than one backend with independent sync
// cursors. SQLite's ALTER TABLE can't change a primary key; copy
// existing rows into a fresh table with the composite
// (k, backend) primary key, then swap the tables.
//
// Existing rows land under the `default` backend id, which the
// dofs sync helpers also use as the fallback when a caller
// doesn't pass an id. Pre-multi-backend workspaces keep their
// pushRev / fetchRev cursors intact through the upgrade.
function v3_to_v4_watermark_backend_column(db: Database): void {
  db.run(`ALTER TABLE _vfs_watermark RENAME TO _vfs_watermark_v3`);
  db.run(
    `CREATE TABLE _vfs_watermark (
       k       TEXT    NOT NULL,
       backend TEXT    NOT NULL DEFAULT 'default',
       v       INTEGER NOT NULL,
       PRIMARY KEY (k, backend)
     )`,
  );
  db.run(
    `INSERT INTO _vfs_watermark (k, backend, v)
       SELECT k, 'default', v FROM _vfs_watermark_v3`,
  );
  db.run(`DROP TABLE _vfs_watermark_v3`);
}

// v4 → v5 — rebuild `vfs_dirents` and `vfs_chunks` as WITHOUT ROWID.
// SQLite can't convert a table to WITHOUT ROWID in place, so for each
// table: rename it aside, create the WITHOUT ROWID replacement, copy
// the rows, drop the old table.
//
// Both targets are FK-inert (neither is an FK parent or child; the
// schema's only foreign key is vfs_blob_bytes -> vfs_blobs) and have
// composite primary keys with no AUTOINCREMENT, so WITHOUT ROWID is
// legal and sqlite_sequence is untouched. `vfs_blob_bytes` is left
// alone on purpose — it holds the large blob payloads and the FK.
//
// A RENAME carries the table's secondary index along to the temp
// name, and the following DROP takes the index with it. The baseline
// `CREATE INDEX IF NOT EXISTS` in initializeSchema already ran, before
// migrations, and does not re-run — so this migrator must recreate
// vfs_dirents_by_child and vfs_chunks_by_hash itself, or upgraded
// databases silently lose them. Keep the CREATE bodies in lockstep
// with the fresh-install DDL in core.ts.
function v4_to_v5_without_rowid(db: Database): void {
  // vfs_dirents
  db.run(`ALTER TABLE vfs_dirents RENAME TO vfs_dirents_v4`);
  db.run(
    `CREATE TABLE vfs_dirents (
       parent_inode INTEGER NOT NULL,
       name         TEXT    NOT NULL,
       child_inode  INTEGER NOT NULL,
       PRIMARY KEY (parent_inode, name)
     ) WITHOUT ROWID`,
  );
  db.run(
    `INSERT INTO vfs_dirents (parent_inode, name, child_inode)
       SELECT parent_inode, name, child_inode FROM vfs_dirents_v4`,
  );
  db.run(`DROP TABLE vfs_dirents_v4`);
  db.run(`CREATE INDEX vfs_dirents_by_child ON vfs_dirents(child_inode)`);

  // vfs_chunks
  db.run(`ALTER TABLE vfs_chunks RENAME TO vfs_chunks_v4`);
  db.run(
    `CREATE TABLE vfs_chunks (
       inode INTEGER NOT NULL,
       idx   INTEGER NOT NULL,
       hash  BLOB    NOT NULL,
       size  INTEGER NOT NULL,
       PRIMARY KEY (inode, idx)
     ) WITHOUT ROWID`,
  );
  db.run(
    `INSERT INTO vfs_chunks (inode, idx, hash, size)
       SELECT inode, idx, hash, size FROM vfs_chunks_v4`,
  );
  db.run(`DROP TABLE vfs_chunks_v4`);
  db.run(`CREATE INDEX vfs_chunks_by_hash ON vfs_chunks(hash)`);
}

// v5 → v6 — add `vfs_changes_by_op_rev`. The push tick's tombstone
// query filters `rev > ? AND op = 'delete'` and groups by path;
// without an (op, rev) index the planner scans vfs_changes in path
// order and never applies the rev predicate, reading the whole table
// to return the few rows inside the watermark window.
//
// Index-only migration: no table is rewritten and no row is touched,
// so existing tombstones carry through untouched. The CREATE is
// duplicated in `sync.ts`'s fresh-install DDL; keep the two in
// lockstep. IF NOT EXISTS keeps this safe if a database somehow
// already has the index.
function v5_to_v6_changes_op_rev_index(db: Database): void {
  db.run(`CREATE INDEX IF NOT EXISTS vfs_changes_by_op_rev ON vfs_changes(op, rev)`);
}

export const MIGRATIONS: readonly Migration[] = [
  { from: 1, to: 2, migrator: v1_to_v2_add_mounts_mode },
  { from: 2, to: 3, migrator: v2_to_v3_add_size_column },
  { from: 3, to: 4, migrator: v3_to_v4_watermark_backend_column },
  { from: 4, to: 5, migrator: v4_to_v5_without_rowid },
  { from: 5, to: 6, migrator: v5_to_v6_changes_op_rev_index },
] as const;

// Apply every migration whose `from` matches the current version,
// in order, until we reach the target. The caller has already
// wrapped this in a transactionSync; failures here roll the whole
// initializeSchema call back.
export function runMigrations(db: Database, current: number, target: number): number {
  let version = current;
  while (version < target) {
    const next = MIGRATIONS.find((m) => m.from === version);
    if (next === undefined) {
      // No migration registered for this jump. This is a bug — the
      // version was bumped without a matching migration.
      throw new Error(`dofs schema: no migration registered for v${version} -> v${target}`);
    }
    next.migrator(db);
    version = next.to;
  }
  return version;
}
