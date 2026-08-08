import type { FileStore } from "./types.js";

interface LockEntry {
  path: string;
  subtree: boolean;
  done: Promise<void>;
}

export interface FileLockOptions {
  /** Exclude mutations at this path and every ancestor or descendant. */
  subtree?: boolean;
}

const storeLocks = new WeakMap<object, Set<LockEntry>>();

export async function withFileLock<T>(
  store: FileStore,
  path: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const identity = store.lockIdentity ?? store;
  let locks = storeLocks.get(identity);
  if (locks === undefined) {
    locks = new Set();
    storeLocks.set(identity, locks);
  }

  const normalizedPath = normalizePath(path);
  const subtree = options.subtree === true;
  const previous = [...locks]
    .filter((entry) => conflicts(normalizedPath, subtree, entry.path, entry.subtree))
    .map((entry) => entry.done);
  let release: (() => void) | undefined;
  const current: LockEntry = {
    path: normalizedPath,
    subtree,
    done: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  locks.add(current);

  await Promise.all(previous);
  try {
    return await operation();
  } finally {
    release?.();
    locks.delete(current);
    if (locks.size === 0) storeLocks.delete(identity);
  }
}

function conflicts(
  leftPath: string,
  leftSubtree: boolean,
  rightPath: string,
  rightSubtree: boolean,
) {
  if (leftPath === rightPath) return true;
  if (!leftSubtree && !rightSubtree) return false;
  return isDescendant(leftPath, rightPath) || isDescendant(rightPath, leftPath);
}

function isDescendant(path: string, ancestor: string): boolean {
  if (path === ancestor) return true;
  if (ancestor === "/") return path.startsWith("/");
  if (ancestor === "") return !path.startsWith("/");
  return path.startsWith(`${ancestor}/`);
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
