// Bounded runtime ownership cache for process-local execution ids.
// Returned execution handles carry their runtime id directly; durable
// fallback keeps public by-id lifecycle methods fenced across Durable
// Object incarnations and cache eviction.

import type { Database } from "@cloudflare/dofs";

const DEFAULT_MAX_ENTRIES = 1_024;

export interface ExecutionRuntimeStore {
  get(key: string): string | undefined;
  remember(key: string, runtimeId: string): void;
  delete(key: string, expectedRuntimeId?: string): void;
}

export class SqlExecutionRuntimeStore implements ExecutionRuntimeStore {
  constructor(private readonly db: Database) {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS computer_execution_runtime (
        execution_key TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL
      )
    `);
  }

  get(key: string): string | undefined {
    return this.db.scalar<string>(
      "SELECT runtime_id FROM computer_execution_runtime WHERE execution_key = ?",
      key,
    );
  }

  remember(key: string, runtimeId: string): void {
    this.db.run(
      `INSERT INTO computer_execution_runtime (execution_key, runtime_id)
       VALUES (?, ?)
       ON CONFLICT(execution_key) DO UPDATE SET runtime_id = excluded.runtime_id`,
      key,
      runtimeId,
    );
  }

  delete(key: string, expectedRuntimeId?: string): void {
    if (expectedRuntimeId === undefined) {
      this.db.run("DELETE FROM computer_execution_runtime WHERE execution_key = ?", key);
      return;
    }
    this.db.run(
      "DELETE FROM computer_execution_runtime WHERE execution_key = ? AND runtime_id = ?",
      key,
      expectedRuntimeId,
    );
  }
}

export class ExecutionRuntimeTracker {
  readonly #entries = new Map<string, string>();
  readonly #maxEntries: number;
  readonly #store: ExecutionRuntimeStore | undefined;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, store?: ExecutionRuntimeStore) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("ExecutionRuntimeTracker maxEntries must be a positive integer");
    }
    this.#maxEntries = maxEntries;
    this.#store = store;
  }

  get(key: string): string | undefined {
    const cached = this.#entries.get(key);
    if (cached !== undefined) {
      this.#touch(key, cached);
      return cached;
    }
    const stored = this.#store?.get(key);
    if (stored !== undefined) this.#touch(key, stored);
    return stored;
  }

  remember(key: string, runtimeId: string): void {
    this.#store?.remember(key, runtimeId);
    this.#touch(key, runtimeId);
  }

  delete(key: string, expectedRuntimeId?: string): void {
    this.#store?.delete(key, expectedRuntimeId);
    if (expectedRuntimeId !== undefined && this.#entries.get(key) !== expectedRuntimeId) return;
    this.#entries.delete(key);
  }

  #touch(key: string, runtimeId: string): void {
    // Map iteration order is insertion order. Reinsert reads so the
    // first key remains the least recently used one.
    this.#entries.delete(key);
    this.#entries.set(key, runtimeId);
    if (this.#entries.size <= this.#maxEntries) return;
    const oldest = this.#entries.keys().next().value;
    if (oldest !== undefined) this.#entries.delete(oldest);
  }
}
