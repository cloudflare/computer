import type { FileStore } from "./types.js";

const storeLocks = new WeakMap<object, Map<string, Promise<void>>>();

export async function withFileLock<T>(
  store: FileStore,
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const identity = store.lockIdentity ?? store;
  let paths = storeLocks.get(identity);
  if (paths === undefined) {
    paths = new Map();
    storeLocks.set(identity, paths);
  }

  const key = normalizePath(path);
  const previous = paths.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  paths.set(key, current);

  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (paths.get(key) === current) paths.delete(key);
    if (paths.size === 0) storeLocks.delete(identity);
  }
}

function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const normalized = parts.join("/");
  return absolute ? `/${normalized}` : normalized;
}
