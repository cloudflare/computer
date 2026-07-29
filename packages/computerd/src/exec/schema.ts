// computerd-owned tables in the same SQLite DB as dofs.
//
// The exec log is a computerd runtime concern, not a dofs
// storage concern, so the schema lives here. CREATE TABLE IF NOT
// EXISTS keeps it idempotent across restarts; the runner calls
// initializeExecSchema() once at construction.

import type { Database } from "@cloudflare/dofs";

// Single table, middle-ground shape: one row per event, kind
// discriminates stdout/stderr/exit, value
// holds the raw bytes (or a 4-byte LE exit code for kind=2). An
// auxiliary `computerd_exec_meta` row sticks around after eviction so
// replay() can distinguish ELOG_TRUNCATED from ENOENT.
export function initializeExecSchema(db: Database): void {
  db.run(`
		CREATE TABLE IF NOT EXISTS computerd_exec_log (
			exec_id TEXT NOT NULL,
			seq     INTEGER NOT NULL,
			ts      INTEGER NOT NULL,
			kind    INTEGER NOT NULL,
			value   BLOB NOT NULL,
			PRIMARY KEY (exec_id, seq)
		) WITHOUT ROWID
	`);
  db.run(`
		CREATE TABLE IF NOT EXISTS computerd_exec_meta (
			exec_id    TEXT PRIMARY KEY,
			started_at INTEGER NOT NULL,
			exited_at  INTEGER,
			exit_code  INTEGER,
			bytes      INTEGER NOT NULL DEFAULT 0,
			evicted    INTEGER NOT NULL DEFAULT 0
		)
	`);
  // Index for retention sweep: "give me every meta row whose
  // exited_at predates the cutoff". With workloads of a few dozen
  // active execs this is overkill, but it's free.
  db.run(`
		CREATE INDEX IF NOT EXISTS computerd_exec_meta_exited_at
		ON computerd_exec_meta (exited_at)
		WHERE exited_at IS NOT NULL
	`);
}

// Wipe any state left behind by a previous computerd process. No exec
// survives a restart (the children are gone), so the safe
// behaviour is to clear the slate.
export function clearExecState(db: Database): void {
  db.run(`DELETE FROM computerd_exec_log`);
  db.run(`DELETE FROM computerd_exec_meta`);
}
