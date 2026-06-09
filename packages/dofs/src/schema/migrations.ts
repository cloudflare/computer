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

export const MIGRATIONS: readonly Migration[] = [
  { from: 1, to: 2, migrator: v1_to_v2_add_mounts_mode },
  { from: 2, to: 3, migrator: v2_to_v3_add_size_column },
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
