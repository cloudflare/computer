import { createWorkspaceError } from "../errors.js";
import type { Database } from "../storage.js";
import { CORE_STATEMENTS, ROOT_INODE, SCHEMA_VERSION } from "./core.js";
import { runMigrations } from "./migrations.js";
import { SYNC_STATEMENTS } from "./sync.js";

export { ROOT_INODE, SCHEMA_VERSION } from "./core.js";

interface MetaRow {
  v: number;
}

export function initializeSchema(db: Database, now: () => number): void {
  db.transactionSync(() => {
    // 1. Baseline DDL. Every statement is "CREATE TABLE IF NOT
    //    EXISTS" / "CREATE INDEX IF NOT EXISTS" so this is a no-op
    //    on already-initialized databases. Fresh databases come out
    //    of this step at the latest column shape (SCHEMA_VERSION).
    for (const statement of CORE_STATEMENTS) {
      db.run(statement);
    }
    for (const statement of SYNC_STATEMENTS) {
      db.run(statement);
    }

    // 2. Read the on-disk schema version. Absent → 0 (very first
    //    boot of this database). The baseline above just created
    //    every table at the latest shape, so a 0 → SCHEMA_VERSION
    //    jump has nothing to migrate.
    const storedVersion = db.one<MetaRow>(
      "SELECT v FROM vfs_meta WHERE k = ?",
      "schema_version",
    )?.v;
    const onDiskVersion = storedVersion ?? 0;

    if (onDiskVersion > SCHEMA_VERSION) {
      throw createWorkspaceError(
        "EIO",
        `Unsupported workspace filesystem schema version ${onDiskVersion}`,
      );
    }

    // 3. Migrate. Skip when the database is fresh (0) — the
    //    baseline DDL already shipped the latest shape. Otherwise
    //    dispatch each registered migrator until we hit the
    //    target.
    if (onDiskVersion > 0 && onDiskVersion < SCHEMA_VERSION) {
      runMigrations(db, onDiskVersion, SCHEMA_VERSION);
    }

    // 4. Stamp the version and seed the boot rows. Both shapes
    //    (insert-if-missing, then update) keep this idempotent so
    //    repeat calls do nothing.
    db.run("INSERT OR IGNORE INTO vfs_meta (k, v) VALUES (?, ?)", "schema_version", SCHEMA_VERSION);
    db.run("UPDATE vfs_meta SET v = ? WHERE k = ?", SCHEMA_VERSION, "schema_version");
    db.run("INSERT OR IGNORE INTO vfs_meta (k, v) VALUES (?, ?)", "rev", 1);
    db.run(
      "INSERT OR IGNORE INTO _vfs_watermark (k, backend, v) VALUES (?, 'default', ?)",
      "pushRev",
      0,
    );
    db.run(
      "INSERT OR IGNORE INTO _vfs_watermark (k, backend, v) VALUES (?, 'default', ?)",
      "fetchRev",
      0,
    );
    db.run(
      "INSERT OR IGNORE INTO _vfs_fetch_cursor (k, backend, path) VALUES (?, 'default', ?)",
      "fetch",
      null,
    );
    db.run(
      "INSERT OR IGNORE INTO _vfs_push_cursor (k, backend, rev, path) VALUES (?, 'default', ?, ?)",
      "push",
      0,
      null,
    );

    db.run(
      `INSERT OR IGNORE INTO vfs_nodes
        (inode, type, mode, mtime, rev)
        VALUES (?, 'dir', ?, ?, 0)`,
      ROOT_INODE,
      0o755,
      now(),
    );
  });
}
