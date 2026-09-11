// Real-DB DurableObjectStorageLike for unit tests. Backed by Node's
// built-in node:sqlite running an in-memory database. Workers' DO SQL
// surface is a subset of this, so anything that works here works on
// the real platform too.
//
// The implementation lives in ./node-storage.ts, which serves both
// this fixture and the on-disk store computerd runs in production.
// This class is the in-memory pinning of it, kept as its own name
// because several hundred tests construct it with no arguments.
//
// This module reaches node:sqlite through that import and therefore
// cannot be loaded under workerd. RecordingStorage — the
// pure-JS fixture that also lives in dofs's testing surface
// — has moved to ./testing-recording.ts so it can be imported
// from workerd-runnable tests. We re-export it here so existing
// `import { RecordingStorage } from "@cloudflare/dofs/testing"`
// call sites keep working under node.

import { NodeSQLiteStorage } from "./node-storage.js";

export type { ExecutedStatement } from "./testing-recording.js";
export { RecordingStorage } from "./testing-recording.js";

// Kept as its own name, and kept taking no arguments, because
// several hundred call sites construct it that way. Collapsing it
// into NodeSQLiteStorage would touch every one of them for no gain.
export class SQLiteTestStorage extends NodeSQLiteStorage {
  constructor() {
    super({ location: ":memory:" });
  }
}
