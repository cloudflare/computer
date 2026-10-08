// Workers-backed implementation. Vitest config aliases ./with-db.js to
// this file when running under @cloudflare/vitest-pool-workers, so every
// test that calls withDB(fn) ends up driving a real Durable Object's
// SQLite storage instead of a node:sqlite in-memory DB.

import { env, runInDurableObject } from "cloudflare:test";
import type { TestBindings } from "../../tests/worker.js";
import { initializeSchema } from "../schema/index.js";
import { Database } from "../storage.js";

export interface WithDBOptions {
  now?: () => number;
}

// Each call gets a fresh DO instance so tests don't bleed into each
// other. newUniqueId() gives a name that never collides between runs.
function freshStub() {
  const id = (env as unknown as TestBindings).TestStorage.newUniqueId();
  return (env as unknown as TestBindings).TestStorage.get(id);
}

export async function withDB<T>(
  fn: (db: Database) => T | Promise<T>,
  options: WithDBOptions = {},
): Promise<T> {
  const stub = freshStub();
  return runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
    const db = new Database(state.storage);
    initializeSchema(db, options.now ?? (() => 1000));
    return await fn(db);
  });
}

// Two independent DOs. Each newUniqueId() gives a fresh DO with its
// own SqlStorage. We can't nest runInDurableObject calls because
// workerd hard-isolates I/O objects between DOs in the same isolate
// (the Database wrapper captures the SqlStorage as such an object).
// Snapshot A's outputs to plain serializable values inside its DO
// context, then apply them in B's. The caller drives the two passes
// via a snapshot and apply callback pair.
//
// This is the workerd shape; the node-side withTwoDBs runs both
// callbacks in the same process with two real SQLiteTestStorage
// instances. Tests that need the simpler signature should branch on
// the node-only path.
export async function withTwoDBs<S, T>(
  snapshot: (a: Database) => S | Promise<S>,
  apply: (b: Database, snapshot: S) => T | Promise<T>,
  options: WithDBOptions = {},
): Promise<T> {
  const stubA = freshStub();
  const stubB = freshStub();
  const now = options.now ?? (() => 1000);
  const captured = await runInDurableObject(
    stubA,
    async (_a: unknown, stateA: DurableObjectState) => {
      const a = new Database(stateA.storage);
      initializeSchema(a, now);
      return await snapshot(a);
    },
  );
  return runInDurableObject(stubB, async (_b: unknown, stateB: DurableObjectState) => {
    const b = new Database(stateB.storage);
    initializeSchema(b, now);
    return await apply(b, captured);
  });
}
