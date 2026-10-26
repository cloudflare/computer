// Directory watcher backed by polling vfs_meta.rev.
//
// On each tick, coalesceChanges yields every path touched since
// the watcher last looked. We filter by the watched directory and
// recursive flag, then emit one 'change' event per path with
// fs.watch-compatible (eventType, filename) arguments.
//
// The polling cadence is the provider's watchIntervalMs (default
// 100 ms). That's already what node's fs.watch uses internally on
// platforms without inotify, and it's slow enough that the SQL
// scan stays in the noise even with many watchers active.
//
// Coverage: there is no watch.test.ts here because watch is only
// reachable through SQLiteWorkspaceProvider.watch /
// watchAsyncIterable; the test surface is provider.watch.test.ts,
// which exercises both the EventEmitter and the AsyncIterable
// adapters end-to-end.

import { EventEmitter } from "node:events";

import { canonicalizePath } from "../path";
import type { Database } from "../storage";
import { coalesceChanges } from "../sync/coalesce";
import { currentRev } from "../sync/watermarks";

export interface WatchOptions {
  // Recurse into subdirectories. When false (default) the watcher
  // only fires for direct children of `path`.
  recursive?: boolean;
  // AbortSignal that closes the watcher when triggered.
  signal?: AbortSignal;
  // Override the poll interval. Default comes from the provider.
  interval?: number;
}

export interface WatchEvent {
  eventType: "rename" | "change";
  filename: string;
}

export interface WatchHandle extends EventEmitter {
  close(): void;
}

export function createWatcher(
  db: Database,
  path: string,
  options: WatchOptions,
  defaultInterval: number,
): WatchHandle {
  const { path: canonical } = canonicalizePath(path);
  const prefix = canonical === "/" ? "/" : `${canonical}/`;
  const recursive = options.recursive === true;
  const interval = options.interval ?? defaultInterval;

  const emitter = new EventEmitter() as WatchHandle;
  let cursor = currentRev(db);
  let closed = false;

  const tick = async () => {
    if (closed) return;
    try {
      const seen = new Set<string>();
      for await (const entry of coalesceChanges(db, cursor)) {
        // Filter to entries inside the watched scope.
        if (!isInScope(entry.path, canonical, prefix, recursive)) continue;
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        const filename = relativeName(entry.path, canonical);
        const eventType: "rename" | "change" = entry.kind === "delete" ? "rename" : "change";
        emitter.emit("change", eventType, filename);
      }
      cursor = currentRev(db);
    } catch (error) {
      emitter.emit("error", error);
    }
  };

  const handle = setInterval(() => void tick(), interval);
  handle.unref?.();

  emitter.close = () => {
    if (closed) return;
    closed = true;
    clearInterval(handle);
    emitter.emit("close");
  };

  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      emitter.close();
    } else {
      options.signal.addEventListener("abort", () => emitter.close(), {
        once: true,
      });
    }
  }

  return emitter;
}

function isInScope(
  entryPath: string,
  watchedPath: string,
  prefix: string,
  recursive: boolean,
): boolean {
  if (entryPath === watchedPath) return true;
  if (!entryPath.startsWith(prefix)) return false;
  if (recursive) return true;
  // Non-recursive: only direct children. No extra '/' in the
  // remainder past the prefix.
  const remainder = entryPath.slice(prefix.length);
  return !remainder.includes("/");
}

function relativeName(entryPath: string, watchedPath: string): string {
  if (entryPath === watchedPath) return "";
  const prefix = watchedPath === "/" ? "/" : `${watchedPath}/`;
  return entryPath.startsWith(prefix) ? entryPath.slice(prefix.length) : entryPath;
}

// Adapter from EventEmitter-based watcher to AsyncIterable for
// for-await consumers. Mirrors @platformatic/vfs's VFSWatchAsyncIterable.
export function createWatchAsyncIterable(watcher: WatchHandle): AsyncIterable<WatchEvent> & {
  return(): Promise<{ value: undefined; done: true }>;
} {
  const pending: WatchEvent[] = [];
  const waiters: ((result: IteratorResult<WatchEvent>) => void)[] = [];
  let done = false;

  watcher.on("change", (eventType: "rename" | "change", filename: string) => {
    const event: WatchEvent = { eventType, filename };
    const next = waiters.shift();
    if (next) next({ value: event, done: false });
    else pending.push(event);
  });
  watcher.on("close", () => {
    done = true;
    while (waiters.length > 0) {
      const next = waiters.shift();
      if (next) next({ value: undefined as never, done: true });
    }
  });

  return {
    [Symbol.asyncIterator]() {
      return this as unknown as AsyncIterator<WatchEvent>;
    },
    next(): Promise<IteratorResult<WatchEvent>> {
      const buffered = pending.shift();
      if (buffered) return Promise.resolve({ value: buffered, done: false });
      if (done) return Promise.resolve({ value: undefined as never, done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
    async return() {
      watcher.close();
      return { value: undefined, done: true as const };
    },
  } as unknown as AsyncIterable<WatchEvent> & {
    return(): Promise<{ value: undefined; done: true }>;
  };
}
