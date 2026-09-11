// A DurableObjectStorageLike backed by node:sqlite, either in memory
// or on a file.
//
// This module cannot be re-exported from the package's main entry
// point. That entry has to load under workerd, which has no
// node:sqlite, and an import of it there fails at module load rather
// than at the call site. It ships under the "./node" export instead,
// and the in-memory pinning used by tests lives in ./testing.ts.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { DurableObjectStorageLike, SQLCursorLike } from "./types.js";

export type JournalMode = "wal" | "delete" | "memory";
export type SynchronousLevel = "off" | "normal" | "full";

export interface NodeSQLiteStorageOptions {
  // A filesystem path, or ":memory:".
  location: string;
  journalMode?: JournalMode;
  // Page cache budget, in bytes. SQLite's own pragma wants a negative
  // number of kibibytes; the conversion happens at the pragma so
  // every size on this interface stays in one unit.
  cacheSizeBytes?: number;
  mmapSizeBytes?: number;
  synchronous?: SynchronousLevel;
  tempStore?: "default" | "file" | "memory";
  busyTimeoutMs?: number;
}

export interface CheckpointResult {
  walFrames: number;
  sizeBytes: number;
  durationMs: number;
}

const IN_MEMORY_LOCATION = ":memory:";

// Defaults for a file-backed store. Cache size makes little
// difference to read speed in practice: a 2 MiB cache against a
// 3.8 MiB database reads as fast as a 256 MiB one, because the
// operating system caches the pages SQLite drops. Numbers in
// packages/computerd/bench-results.md.
const DEFAULT_CACHE_SIZE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MMAP_SIZE_BYTES = 256 * 1024 * 1024;
// One writer, but a snapshot tool or a second connection should wait
// rather than fail outright.
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

class NodeCursor<Row extends object> implements SQLCursorLike<Row> {
  private readonly rows: Row[];

  constructor(rows: Row[]) {
    this.rows = rows;
  }

  toArray(): Row[] {
    return this.rows;
  }
}

export class NodeSQLiteStorage implements DurableObjectStorageLike {
  readonly location: string;
  private readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  readonly sql: {
    exec: <Row extends object>(query: string, ...bindings: unknown[]) => SQLCursorLike<Row>;
  };

  constructor(options: NodeSQLiteStorageOptions) {
    this.location = options.location;
    const onDisk = options.location !== IN_MEMORY_LOCATION;
    if (onDisk) {
      mkdirSync(dirname(options.location), { recursive: true });
    }
    this.db = new DatabaseSync(options.location);
    this.applyPragmas(options, onDisk);
    this.sql = {
      exec: <Row extends object>(query: string, ...bindings: unknown[]): SQLCursorLike<Row> => {
        let stmt = this.cache.get(query);
        if (stmt === undefined) {
          stmt = this.db.prepare(query);
          this.cache.set(query, stmt);
        }
        const normalized = bindings.map(toSQLiteValue);
        const rows = (stmt.all(...(normalized as never[])) as Row[]) ?? [];
        return new NodeCursor<Row>(rows);
      },
    };
  }

  // Every default here applies only to a file-backed store. An
  // in-memory database has no disk to tune against, and forcing a
  // journal mode on it would change behavior the several hundred
  // tests built on SQLiteTestStorage already depend on.
  private applyPragmas(options: NodeSQLiteStorageOptions, onDisk: boolean): void {
    const journalMode = options.journalMode ?? (onDisk ? "wal" : undefined);
    if (journalMode !== undefined) {
      this.db.exec(`PRAGMA journal_mode = ${journalMode}`);
    }
    // "normal" fsyncs on checkpoint rather than on every commit. Safe
    // here because the durable object holds the authoritative copy:
    // losing the last few transactions to a host crash costs a
    // re-push, not data. Measured at roughly a third faster than
    // "full" for file creation. "off" is faster still and closes the
    // gap to the in-memory store entirely, but it risks a corrupt
    // database rather than merely losing recent writes, so it is not
    // the default.
    const synchronous = options.synchronous ?? (onDisk ? "normal" : undefined);
    if (synchronous !== undefined) {
      this.db.exec(`PRAGMA synchronous = ${synchronous}`);
    }
    const cacheSizeBytes =
      options.cacheSizeBytes ?? (onDisk ? DEFAULT_CACHE_SIZE_BYTES : undefined);
    if (cacheSizeBytes !== undefined) {
      // SQLite reads a negative cache_size as a budget in kibibytes
      // and a positive one as a count of pages. We want the byte
      // budget, so the sign is deliberate rather than a slip.
      const kibibytes = Math.max(1, Math.floor(cacheSizeBytes / 1024));
      this.db.exec(`PRAGMA cache_size = -${kibibytes}`);
    }
    const mmapSizeBytes = options.mmapSizeBytes ?? (onDisk ? DEFAULT_MMAP_SIZE_BYTES : undefined);
    if (mmapSizeBytes !== undefined) {
      this.db.exec(`PRAGMA mmap_size = ${Math.max(0, Math.floor(mmapSizeBytes))}`);
    }
    const tempStore = options.tempStore ?? (onDisk ? "memory" : undefined);
    if (tempStore !== undefined) {
      this.db.exec(`PRAGMA temp_store = ${tempStore}`);
    }
    const busyTimeoutMs = options.busyTimeoutMs ?? (onDisk ? DEFAULT_BUSY_TIMEOUT_MS : undefined);
    if (busyTimeoutMs !== undefined) {
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    }
  }

  transactionSync<T>(closure: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = closure();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Fold the write-ahead log back into the main database file. A host
  // about to ask the platform for a disk snapshot calls this first so
  // the snapshot captures one file rather than a file plus a log
  // segment that a restore would have to replay.
  //
  // TRUNCATE rather than PASSIVE: it waits until the log is fully
  // folded and then empties it, which is the state a snapshot wants.
  checkpoint(): CheckpointResult {
    const startedAt = Date.now();
    let walFrames = 0;
    if (this.location !== IN_MEMORY_LOCATION) {
      const rows = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all() as unknown as Array<
        Record<string, number>
      >;
      const row = rows[0];
      if (row !== undefined) {
        // The pragma answers with three unnamed columns: a busy flag,
        // the frames the log held, and the frames folded down. Column
        // names differ across SQLite builds, so read by position.
        const values = Object.values(row);
        walFrames = typeof values[1] === "number" && values[1] > 0 ? values[1] : 0;
      }
    }
    return {
      walFrames,
      sizeBytes: this.sizeBytes(),
      durationMs: Date.now() - startedAt,
    };
  }

  sizeBytes(): number {
    const pageCount = this.scalarNumber("PRAGMA page_count");
    const pageSize = this.scalarNumber("PRAGMA page_size");
    return pageCount * pageSize;
  }

  freelistCount(): number {
    return this.scalarNumber("PRAGMA freelist_count");
  }

  private scalarNumber(pragma: string): number {
    const rows = this.db.prepare(pragma).all() as unknown as Array<Record<string, unknown>>;
    const row = rows[0];
    if (row === undefined) return 0;
    const value = Object.values(row)[0];
    return typeof value === "number" ? value : 0;
  }

  close(): void {
    this.cache.clear();
    this.db.close();
  }
}

function toSQLiteValue(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  throw new TypeError(`NodeSQLiteStorage cannot bind value of type ${typeof value}`);
}
