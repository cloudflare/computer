// just-bash's sqlite3 command executes queries in a Node Worker thread. The
// Workers runtime exposes the node:worker_threads API surface but does not
// implement the Worker constructor. A WorkerShellBackend already runs in its
// own Dynamic Worker isolate, so execute the query worker in that isolate while
// preserving the small EventEmitter protocol just-bash expects.

import { executeQuery } from "computer:sqlite-query-worker";

class InlineSqliteWorker {
  #listeners = new Map();
  #terminated = false;

  constructor(workerData) {
    queueMicrotask(() => {
      void executeQuery(workerData)
        .then((result) => {
          this.#emit("message", {
            ...result,
            protocolToken: workerData.protocolToken,
          });
        })
        .catch((error) => this.#emit("error", error));
    });
  }

  on(event, listener) {
    let listeners = this.#listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener);
    return this;
  }

  removeListener(event, listener) {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  async terminate() {
    this.#terminated = true;
    return 0;
  }

  #emit(event, value) {
    if (this.#terminated) return;
    for (const listener of this.#listeners.get(event) ?? []) listener(value);
  }
}

// WorkspaceFsAdapter has no Node dev/ino pair because its storage is remote.
// It also does not support hard links, so a canonical path is a stable lock
// identity for the database. Keep this compatibility layer in SQLite's lazy
// chunk instead of adding bytes to every Worker shell.
function filesystemWithStableIdentity(fs) {
  return new Proxy(fs, {
    get(target, property) {
      if (property === "stat") {
        return async (path) => {
          const stat = await target.stat(path);
          if (stat.identity !== undefined || (stat.dev !== undefined && stat.ino !== undefined)) {
            return stat;
          }
          return { ...stat, identity: await target.realpath(path) };
        };
      }

      // WorkspaceFsAdapter uses private fields, so methods must retain the
      // original receiver rather than receiving this Proxy as `this`.
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function createInlineSqliteWorker(workerData) {
  return new InlineSqliteWorker(workerData);
}

export function adaptSqliteCommand(command) {
  return {
    ...command,
    execute(args, context) {
      return command.execute(args, {
        ...context,
        fs: filesystemWithStableIdentity(context.fs),
      });
    },
  };
}
