import type { DurableObjectStorageLike, SQLStorageLike } from "./types";

export class Database {
  readonly sql: SQLStorageLike;
  readonly transactionSync: <T>(closure: () => T) => T;
  // Depth counter for transactionSync calls on the stack. Every call,
  // nested or not, goes to the storage adapter's transactionSync when it
  // has one: Durable Object storage and NodeSQLiteStorage both run a call
  // inside another as a savepoint, so an inner throw rolls back only the
  // inner work. Durable Object storage refuses SAVEPOINT statements
  // issued through sql.exec, which is why nested calls cannot issue them
  // here. Only an adapter without transactionSync gets SAVEPOINTs from
  // this class, since SQLite forbids a real BEGIN inside an active
  // transaction.
  #txDepth = 0;
  // Per-transaction state registered through transactionLocal, keyed by
  // its owner. Present only inside the outermost transactionSync.
  #locals: Map<object, { value: unknown; beforeCommit: (value: unknown) => void }> | undefined;

  constructor(storage: DurableObjectStorageLike) {
    this.sql = storage.sql;
    this.transactionSync = <T>(closure: () => T): T => {
      if (this.#txDepth > 0 && storage.transactionSync === undefined) {
        // Reentrant call on an adapter that cannot nest: use a savepoint.
        // SQLite's RELEASE on a savepoint inside an outer transaction
        // commits the inner work without ending the outer one.
        const sp = `_t${this.#txDepth}`;
        this.sql.exec(`SAVEPOINT ${sp}`);
        this.#txDepth++;
        try {
          const result = closure();
          this.sql.exec(`RELEASE ${sp}`);
          return result;
        } catch (error) {
          this.sql.exec(`ROLLBACK TO ${sp}`);
          this.sql.exec(`RELEASE ${sp}`);
          throw error;
        } finally {
          this.#txDepth--;
        }
      }
      // Outer call: hand off to the storage adapter so the DO
      // runtime's transaction semantics apply.
      const run = (): T => {
        const result = closure();
        if (this.#txDepth === 1) this.#runBeforeCommit();
        return result;
      };
      this.#txDepth++;
      try {
        if (storage.transactionSync !== undefined) {
          // Outer or nested: the adapter's own semantics apply, including
          // the Durable Object runtime's.
          return storage.transactionSync(run);
        }
        if (storage.transaction !== undefined) {
          const result = storage.transaction(run);
          if (
            result !== undefined &&
            result !== null &&
            typeof result === "object" &&
            "then" in result
          ) {
            throw new Error("Durable Object storage adapter requires synchronous transactions");
          }
          return result;
        }
        return run();
      } finally {
        this.#txDepth--;
        if (this.#txDepth === 0) this.#locals = undefined;
      }
    };
  }

  /**
   * @internal
   * State that lives for the current outermost transaction. The first
   * call in a transaction creates the value with `create`; later calls
   * return the same value. Just before the transaction commits, still
   * inside it, `beforeCommit` runs with the value, so whatever it writes
   * commits or rolls back with the rest. A rollback discards the value
   * without calling `beforeCommit`. Throws outside a transaction.
   */
  transactionLocal<V>(key: object, create: () => V, beforeCommit: (value: V) => void): V {
    if (this.#txDepth === 0) {
      throw new Error("transactionLocal called outside transactionSync");
    }
    this.#locals ??= new Map();
    const existing = this.#locals.get(key);
    if (existing !== undefined) return existing.value as V;
    const value = create();
    this.#locals.set(key, { value, beforeCommit: beforeCommit as (value: unknown) => void });
    return value;
  }

  #runBeforeCommit(): void {
    const locals = this.#locals;
    if (locals === undefined) return;
    // A hook may register more state; keep going until none is left.
    for (const [key, { value, beforeCommit }] of locals) {
      locals.delete(key);
      beforeCommit(value);
    }
  }

  // True while a transactionSync closure is on the stack. The resolve
  // cache uses this to refuse populating entries mid-transaction, so a
  // rolled-back mutation can never leave the cache reflecting
  // uncommitted state. (Invalidation still runs freely inside a
  // transaction — dropping an entry is always safe.)
  //
  // Invariant: #txDepth only tracks transactionSync. A raw
  // BEGIN/SAVEPOINT issued through run() would open a transaction this
  // flag can't see, letting the cache populate mid-transaction and
  // survive a rollback — so transactionSync is the only sanctioned way
  // to open one.
  get inTransaction(): boolean {
    return this.#txDepth > 0;
  }

  run(query: string, ...bindings: unknown[]): void {
    this.sql.exec(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    const rows = this.sql.exec(query, ...bindings).toArray() as Row[];
    return rows.map((row) => normalizeRow(row as Record<string, unknown>)) as Row[];
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.all<Row>(query, ...bindings)[0];
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    const row = this.one<Record<string, T>>(query, ...bindings);
    if (row === undefined) {
      return undefined;
    }

    const [value] = Object.values(row);
    return value;
  }
}

// Cloudflare's DO SqlStorage returns BLOB columns as ArrayBuffer,
// whereas node:sqlite returns Uint8Array. Normalise to Uint8Array so
// the rest of the code only has to handle one shape.
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  // node:sqlite hands back rows with a null prototype; the DO SQL
  // flavour returns ArrayBuffer for BLOB columns. Re-key into a plain
  // {} so consumers get Object.prototype-shaped rows (capnweb's
  // serializer keys off Object.prototype to detect "object") and
  // convert any ArrayBuffer to Uint8Array in the same pass.
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    out[key] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  }
  return out;
}
