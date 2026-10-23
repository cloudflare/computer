// Workspace namespaces: more than one Workspace in one Durable
// Object's storage.
//
// Every table a Workspace owns has a fixed name (`vfs_nodes`,
// `_vfs_mounts`, `workspace_runtime_executions`, ...), and the SQL
// that reads and writes them is spread across the filesystem, sync,
// mount, and runtime code. Rather than thread a table prefix through
// all of it, a namespaced Workspace gets a storage handle that renames
// those tables on the way to SQLite. `vfs_nodes` becomes
// `ws_scratch_vfs_nodes` for the namespace `scratch`.
//
// The rename matches only identifiers this package creates. Values
// always travel as bindings, never inside the SQL text, so file data
// is never rewritten.

import type { DurableObjectStorageLike } from "@cloudflare/dofs";

const NAMESPACE = /^[a-z0-9]{1,32}$/;

// Tables, indexes, and migration scratch tables the Workspace
// creates. `\b` stops a match inside a longer identifier.
const WORKSPACE_IDENTIFIER =
  /\b(?:_?vfs_[a-z0-9_]+|workspace_runtime_[a-z0-9_]+|computer_execution_runtime)\b/g;

/**
 * Check a namespace and return the table prefix for it.
 *
 * Namespaces are 1 to 32 lowercase letters and digits. They can't
 * contain `_`, so no two namespaces map to the same table names, and
 * none maps to the default ones.
 */
export function namespacePrefix(namespace: string): string {
  if (!NAMESPACE.test(namespace)) {
    throw new TypeError(
      `Workspace: namespace must be 1 to 32 lowercase letters and digits, got ${JSON.stringify(namespace)}.`,
    );
  }
  return `ws_${namespace}_`;
}

/**
 * Wrap `storage` so the SQL a Workspace runs reads and writes its own
 * copy of the Workspace tables.
 *
 * @param storage - The Durable Object storage to share.
 * @param namespace - 1 to 32 lowercase letters and digits.
 * @returns Storage that renames the Workspace tables for `namespace`.
 */
export function namespacedStorage(
  storage: DurableObjectStorageLike,
  namespace: string,
): DurableObjectStorageLike {
  const prefix = namespacePrefix(namespace);
  const rewrite = (query: string) =>
    query.replace(WORKSPACE_IDENTIFIER, (identifier) => prefix + identifier);
  const namespaced: DurableObjectStorageLike = {
    sql: {
      exec: (query, ...bindings) => storage.sql.exec(rewrite(query), ...bindings),
    },
  };
  if (storage.transactionSync !== undefined) {
    const transactionSync = storage.transactionSync.bind(storage);
    namespaced.transactionSync = (closure) => transactionSync(closure);
  }
  if (storage.transaction !== undefined) {
    const transaction = storage.transaction.bind(storage);
    namespaced.transaction = (closure) => transaction(closure);
  }
  return namespaced;
}
