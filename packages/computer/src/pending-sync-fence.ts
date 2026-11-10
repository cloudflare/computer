// Durable record of command syncs that are still pending, by the
// container runtime that ran each command.
//
// A command whose result says `sync.status: "pending"` promises that a
// later `pull()` finishes its sync. That holds only while the runtime
// that ran it still exists: a replacement container starts empty, so a
// pull from it finds nothing and would report a clean, complete sync.
//
// A fence names a runtime with pending command syncs. Workspace.pull()
// checks the fences against the runtime it reached:
//
//   - A fence for another runtime means that runtime is gone with the
//     files it held. pull() fails the pull operation, clears the fence,
//     and rejects with ESYNC_LOST, once. The next pull() syncs the live
//     runtime.
//   - A fence for this runtime is cleared when a pull operation completes
//     that was captured after the fence was written, so its target covers
//     the commands' writes. Until then pull() does not report complete.
//
// Each fence carries a sequence number that only grows, and each pull
// operation is stamped with the latest sequence number when its target
// was captured. A completed operation covers the fences at or below its
// stamp. Both tables live in the Workspace's SQLite, so they survive
// Durable Object eviction.

import type { Database } from "@cloudflare/dofs";

export class PendingSyncFences {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
    db.run(`
      CREATE TABLE IF NOT EXISTS computer_pending_sync_fence (
        backend TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (backend, runtime_id)
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS computer_pending_sync_stamp (
        backend TEXT PRIMARY KEY,
        generation TEXT NOT NULL,
        seq INTEGER NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS computer_pending_sync_seq (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        seq INTEGER NOT NULL
      )
    `);
  }

  /** The latest sequence number handed out. */
  current(): number {
    return Number(
      this.#db.scalar<number>("SELECT seq FROM computer_pending_sync_seq WHERE id = 0") ?? 0,
    );
  }

  /** Note that a command on `runtimeId` has a pending sync. Returns its sequence number. */
  record(backend: string, runtimeId: string): number {
    const seq = this.current() + 1;
    this.#db.run(
      `INSERT INTO computer_pending_sync_seq (id, seq) VALUES (0, ?)
       ON CONFLICT(id) DO UPDATE SET seq = excluded.seq`,
      seq,
    );
    this.#db.run(
      `INSERT INTO computer_pending_sync_fence (backend, runtime_id, seq) VALUES (?, ?, ?)
       ON CONFLICT(backend, runtime_id) DO UPDATE SET seq = excluded.seq`,
      backend,
      runtimeId,
      seq,
    );
    return seq;
  }

  /** Runtimes other than `runtimeId` that still have pending syncs. */
  stale(backend: string, runtimeId: string): string[] {
    return this.#db
      .all<{ runtime_id: string }>(
        `SELECT runtime_id FROM computer_pending_sync_fence
         WHERE backend = ? AND runtime_id != ? ORDER BY seq`,
        backend,
        runtimeId,
      )
      .map((row) => row.runtime_id);
  }

  has(backend: string, runtimeId: string): boolean {
    return (
      this.#db.scalar<number>(
        `SELECT COUNT(*) FROM computer_pending_sync_fence WHERE backend = ? AND runtime_id = ?`,
        backend,
        runtimeId,
      ) !== 0
    );
  }

  clear(backend: string, runtimeIds: readonly string[]): void {
    for (const runtimeId of runtimeIds) {
      this.#db.run(
        "DELETE FROM computer_pending_sync_fence WHERE backend = ? AND runtime_id = ?",
        backend,
        runtimeId,
      );
    }
  }

  /** Clear this runtime's fence if an operation stamped `seq` covers it. */
  clearCovered(backend: string, runtimeId: string, seq: number): void {
    this.#db.run(
      `DELETE FROM computer_pending_sync_fence
       WHERE backend = ? AND runtime_id = ? AND seq <= ?`,
      backend,
      runtimeId,
      seq,
    );
  }

  /** Stamp a pull operation with the fences its target covers. */
  stamp(backend: string, generation: string, seq: number): void {
    this.#db.run(
      `INSERT INTO computer_pending_sync_stamp (backend, generation, seq) VALUES (?, ?, ?)
       ON CONFLICT(backend) DO UPDATE SET generation = excluded.generation, seq = excluded.seq`,
      backend,
      generation,
      seq,
    );
  }

  stampOf(backend: string, generation: string): number | undefined {
    const seq = this.#db.scalar<number>(
      "SELECT seq FROM computer_pending_sync_stamp WHERE backend = ? AND generation = ?",
      backend,
      generation,
    );
    return seq === undefined || seq === null ? undefined : Number(seq);
  }

  dropStamp(backend: string): void {
    this.#db.run("DELETE FROM computer_pending_sync_stamp WHERE backend = ?", backend);
  }
}
