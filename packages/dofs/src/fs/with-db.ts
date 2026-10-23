// Node-backed implementation. Selected by the default vitest config.
// The workers config aliases this module to ./with-db.workers.ts so the
// same test source runs against a real Durable Object.

import { initializeSchema } from "../schema/index";
import { Database } from "../storage";
import { SQLiteTestStorage } from "../testing";

export interface WithDBOptions {
  now?: () => number;
}

export async function withDB<T>(
  fn: (db: Database) => T | Promise<T>,
  options: WithDBOptions = {},
): Promise<T> {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, options.now ?? (() => 1000));
  try {
    return await fn(db);
  } finally {
    storage.close();
  }
}

// Two independent DBs split across a snapshot/apply pair. The shape
// matches the workerd backend, which can't hold two DOs alive at
// once because of cross-DO I/O isolation — the snapshot pass
// captures everything the apply pass needs as plain serializable
// values.
//
// Under node we run both callbacks in the same process with two
// SQLiteTestStorage instances. Either shape would work here; we
// match the workerd API so test code stays uniform.
export async function withTwoDBs<S, T>(
  snapshot: (a: Database) => S | Promise<S>,
  apply: (b: Database, snapshot: S) => T | Promise<T>,
  options: WithDBOptions = {},
): Promise<T> {
  const storageA = new SQLiteTestStorage();
  const storageB = new SQLiteTestStorage();
  const a = new Database(storageA);
  const b = new Database(storageB);
  const now = options.now ?? (() => 1000);
  initializeSchema(a, now);
  initializeSchema(b, now);
  try {
    const captured = await snapshot(a);
    return await apply(b, captured);
  } finally {
    storageA.close();
    storageB.close();
  }
}
