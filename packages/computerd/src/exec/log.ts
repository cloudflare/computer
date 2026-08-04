// Replay store for a single exec, backed by SQLite.
//
// Every event the runner emits is also written here. The log is
// consulted only by `getExec({ after })` reattach — the *live*
// stream returned from `exec()` reads directly from the child's
// pipes through a ReadableStream so capnweb's flow control reaches
// the kernel pipe via natural pull backpressure.
//
// Size is bounded by the per-exec `maxBytes` cap. Past that, the
// log evicts (DELETEs all rows for the id) and `replay()` throws
// ELOG_TRUNCATED.
//
// Tables and column layout live in schema.ts. Discriminator:
//
//   kind = 0  stdout, value = raw bytes
//   kind = 1  stderr, value = raw bytes
//   kind = 2  exit,   value = 4-byte LE int32 exit code

import type { Database } from "@cloudflare/dofs";

import { ExecError, type ExecEvent } from "./types.js";

const KIND_STDOUT = 0;
const KIND_STDERR = 1;
const KIND_EXIT = 2;

export interface LogOptions {
  maxBytes: number;
  now: () => number;
}

interface MetaRow {
  exec_id: string;
  started_at: number;
  exited_at: number | null;
  exit_code: number | null;
  bytes: number;
  evicted: number;
}

interface EventRow {
  seq: number;
  kind: number;
  value: Uint8Array;
}

// Create a new log row in computerd_exec_meta. Throws if a row with the
// same id already exists — the runner is responsible for disposing
// stale records before spawning a recycled id.
export function createLog(db: Database, id: string, opts: LogOptions): EventLog {
  const startedAt = opts.now();
  db.run(
    `INSERT INTO computerd_exec_meta (exec_id, started_at, bytes, evicted) VALUES (?, ?, 0, 0)`,
    id,
    startedAt,
  );
  return new EventLog(db, id, opts);
}

// Reattach to an existing log row. Returns undefined if no meta
// row exists for the id (i.e. the exec was never spawned, or has
// been disposed).
export function openLog(db: Database, id: string, opts: LogOptions): EventLog | undefined {
  const meta = db.one<MetaRow>(`SELECT * FROM computerd_exec_meta WHERE exec_id = ?`, id);
  if (meta === undefined) return undefined;
  return new EventLog(db, id, opts);
}

export class EventLog {
  readonly id: string;
  private readonly db: Database;
  private readonly opts: LogOptions;
  private nextSeq = 1;

  constructor(db: Database, id: string, opts: LogOptions) {
    this.db = db;
    this.id = id;
    this.opts = opts;
    // Recover nextSeq when openLog() reattaches to a log that the
    // Runner has dropped from memory but whose rows still live in
    // the DB. For fresh logs the COALESCE returns 0.
    const lastSeq =
      this.db.scalar<number>(
        `SELECT COALESCE(MAX(seq), 0) AS s FROM computerd_exec_log WHERE exec_id = ?`,
        id,
      ) ?? 0;
    this.nextSeq = lastSeq + 1;
  }

  append(name: "stdout" | "stderr", value: Uint8Array): number {
    const meta = this.meta();
    if (meta === undefined) throw new Error(`log ${this.id}: append after dispose`);
    if (meta.exited_at !== null) throw new Error(`log ${this.id}: append after exit`);
    const seq = this.nextSeq++;
    if (meta.evicted === 1) {
      // Silently drop. The live stream already got the bytes;
      // we just can't replay them. Keep the seq counter
      // advancing so the live stream's seq numbering stays
      // monotonic and gap-free.
      return seq;
    }
    const kind = name === "stdout" ? KIND_STDOUT : KIND_STDERR;
    const ts = this.opts.now();
    const newBytes = meta.bytes + value.byteLength;
    if (newBytes > this.opts.maxBytes) {
      this.evict();
      return seq;
    }
    this.db.transactionSync(() => {
      this.db.run(
        `INSERT INTO computerd_exec_log (exec_id, seq, ts, kind, value) VALUES (?, ?, ?, ?, ?)`,
        this.id,
        seq,
        ts,
        kind,
        value,
      );
      this.db.run(`UPDATE computerd_exec_meta SET bytes = ? WHERE exec_id = ?`, newBytes, this.id);
    });
    return seq;
  }

  // Advance the seq counter and return the next value without writing
  // any row to the database. Used for events that the runner emits on
  // the live stream but does not need to persist (heartbeats).
  allocSeq(): number {
    return this.nextSeq++;
  }

  setExit(code: number): number {
    const meta = this.meta();
    if (meta === undefined) throw new Error(`log ${this.id}: setExit after dispose`);
    if (meta.exited_at !== null) throw new Error(`log ${this.id}: double exit`);
    const seq = this.nextSeq++;
    const ts = this.opts.now();
    this.db.transactionSync(() => {
      if (meta.evicted === 0) {
        const buf = Buffer.alloc(4);
        buf.writeInt32LE(code, 0);
        this.db.run(
          `INSERT INTO computerd_exec_log (exec_id, seq, ts, kind, value) VALUES (?, ?, ?, ?, ?)`,
          this.id,
          seq,
          ts,
          KIND_EXIT,
          new Uint8Array(buf),
        );
      }
      this.db.run(
        `UPDATE computerd_exec_meta SET exited_at = ?, exit_code = ? WHERE exec_id = ?`,
        ts,
        code,
        this.id,
      );
    });
    return seq;
  }

  // Drop every row for this id, both log and meta. Used on
  // disposeExec() and on Runner shutdown. After this returns,
  // openLog() will return undefined for the id.
  dispose(): void {
    this.db.transactionSync(() => {
      this.db.run(`DELETE FROM computerd_exec_log WHERE exec_id = ?`, this.id);
      this.db.run(`DELETE FROM computerd_exec_meta WHERE exec_id = ?`, this.id);
    });
  }

  // One-shot replay of every event with seq > afterSeq. Throws
  // ELOG_TRUNCATED if the log was evicted (rows gone, meta row
  // still present with evicted=1). `after === "tail"` returns an
  // empty iterator; live tail follow happens on the live stream,
  // not on the log.
  *replay(after: number | "tail" = 0): IterableIterator<ExecEvent> {
    const meta = this.meta();
    if (meta === undefined) {
      throw new ExecError("ENOENT", `no exec record for id ${this.id}`);
    }
    if (meta.evicted === 1) {
      throw new ExecError("ELOG_TRUNCATED", `log for exec ${this.id} has been evicted`);
    }
    if (after === "tail") return;
    const rows = this.db.all<EventRow>(
      `SELECT seq, kind, value FROM computerd_exec_log
			   WHERE exec_id = ? AND seq > ?
			 ORDER BY seq`,
      this.id,
      after,
    );
    for (const row of rows) {
      yield materialise(this.id, row);
    }
  }

  private meta(): MetaRow | undefined {
    return this.db.one<MetaRow>(`SELECT * FROM computerd_exec_meta WHERE exec_id = ?`, this.id);
  }

  private evict(): void {
    this.db.transactionSync(() => {
      this.db.run(`DELETE FROM computerd_exec_log WHERE exec_id = ?`, this.id);
      this.db.run(
        `UPDATE computerd_exec_meta SET bytes = 0, evicted = 1 WHERE exec_id = ?`,
        this.id,
      );
    });
  }
}

function materialise(id: string, row: EventRow): ExecEvent {
  if (row.kind === KIND_EXIT) {
    // node:sqlite returns BLOB as Uint8Array; we need the bytes
    // view to read the int32.
    const view = new DataView(row.value.buffer, row.value.byteOffset, row.value.byteLength);
    return { id, seq: row.seq, name: "exit", code: view.getInt32(0, true) };
  }
  const name = row.kind === KIND_STDOUT ? "stdout" : "stderr";
  return { id, seq: row.seq, name, value: row.value };
}
