import type { DurableObjectStorageLike, SQLCursorLike } from "./types";

// Pure-JS test fixture. Records every SQL statement the production
// code emits, lets the test assert against the trace, and serves a
// tiny in-process subset of vfs_meta semantics so the FS scaffolding
// can boot without dragging node:sqlite in.
//
// Lives in its own file so the workerd test runner can import this
// fixture without loading the SQLiteTestStorage class that wraps
// node:sqlite (which workerd doesn't ship).

export interface ExecutedStatement {
  query: string;
  bindings: unknown[];
}

class TestCursor<Row extends object> implements SQLCursorLike<Row> {
  private readonly rows: Row[];

  constructor(rows: Row[]) {
    this.rows = rows;
  }

  toArray(): Row[] {
    return this.rows;
  }
}

export class RecordingStorage implements DurableObjectStorageLike {
  readonly statements: ExecutedStatement[] = [];
  readonly sql = {
    exec: <Row extends object = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): SQLCursorLike<Row> => {
      this.statements.push({ query, bindings });
      return new TestCursor<Row>(this.rowsFor<Row>(query, bindings));
    },
  };

  private readonly meta = new Map<string, number>();

  constructor(seed?: { schemaVersion?: number; rev?: number }) {
    if (seed?.schemaVersion !== undefined) {
      this.meta.set("schema_version", seed.schemaVersion);
    }
    if (seed?.rev !== undefined) {
      this.meta.set("rev", seed.rev);
    }
  }

  transactionSync<T>(closure: () => T): T {
    return closure();
  }

  private rowsFor<Row extends object>(query: string, bindings: unknown[]): Row[] {
    const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized === "select v from vfs_meta where k = ?") {
      const key = String(bindings[0]);
      const value = this.meta.get(key);
      return value === undefined ? [] : ([{ v: value }] as Row[]);
    }

    if (normalized.startsWith("insert or ignore into vfs_meta")) {
      const key = String(bindings[0]);
      const value = Number(bindings[1]);
      if (!this.meta.has(key)) {
        this.meta.set(key, value);
      }
    }

    if (normalized.startsWith("update vfs_meta set v = ? where k = ?")) {
      this.meta.set(String(bindings[1]), Number(bindings[0]));
    }

    return [];
  }
}
