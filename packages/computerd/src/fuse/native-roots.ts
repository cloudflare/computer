// Native roots: bind-mounts local-only directories onto the mount. See
// packages/computerd/README.md#native-roots.
//
// The local-only layer in passthrough.ts already stores each local-only
// path at MOUNT_IGNORE_PATH/<rel> and serves it through FUSE. A native
// root bind-mounts that same directory at MOUNT_POINT/<rel>, so lookups,
// stats, creates, and listings under it stop reaching this process. The
// source is the directory the FUSE layer serves anyway, which is what
// keeps this simple:
//
// - A mount that lands late, fails, or is detached changes how a path is
//   served, never what it contains. Nothing here is on a correctness
//   path, so every failure is "leave it to the FUSE layer".
// - /proc/self/mountinfo is the only mount state. This module treats every
//   mount strictly below MOUNT_POINT as a native root, including at restart.
//   Other code must not create mounts there: detachAll would detach them.
// - Lazily detaching one of our native roots leaves the same backing
//   directory served through FUSE. This does not apply to unrelated mounts.
// - Removing or renaming a root itself fails with EBUSY in the kernel. For
//   commands computerd runs, the removal guard (vendor/fuse-napi,
//   removal-guard.c) detaches the mount first; this module hands it each
//   root's descriptor and parks whatever it detaches.
// - Renaming a synced directory needs nothing: the kernel moves a mount
//   along with the dentry it sits on. (Re-mounting from the rename reply
//   would race the kernel's own move and stack a second mount.)
//
// One rule is load-bearing: no synchronous filesystem call on the main
// thread may touch a path under MOUNT_POINT. Resolving such a path sends
// FUSE requests that this same thread has to answer, so a synchronous
// call there deadlocks the daemon. Paths under the backing root and
// /proc are fine. The native worker resolves and mounts the target off
// the main thread, using pinned directory descriptors.

import { lstatSync, readdirSync, readFileSync, promises as fsPromises } from "node:fs";
import { dirname, join } from "node:path";

import type { MountIgnoreSet } from "./ignore.js";

export interface NativeRootsOptions {
  /** Resolved MOUNT_IGNORE_PATH: where local-only paths are stored. */
  readonly root: string;
  /** The FUSE mount point. */
  readonly mountPoint: string;
  /** The decided ignore set. */
  readonly ignore: MountIgnoreSet;
  /**
   * Checked on every `ensure`. Lets the daemon build this before the
   * FUSE mount exists and switch it on once passthrough is negotiated.
   */
  readonly active?: () => boolean;
  /** Native operation; injected in tests. Defaults to the confined addon. */
  readonly bindRoot?: (sourceRoot: string, targetRoot: string, rel: string) => Promise<number>;
  readonly unbindRoot?: (targetRoot: string, rel: string) => Promise<number>;
  readonly mountinfo?: () => string;
  readonly lstat?: (path: string) => { isDirectory(): boolean; dev: number; ino: number };
  /** Asynchronous lstat of a path under the mount point. */
  readonly lstatTarget?: (path: string) => Promise<{ isDirectory(): boolean }>;
  readonly readdir?: (path: string) => string[];
  readonly warn?: (message: string) => void;
  /** Opens a directory under the mount, off the main thread. Injected for tests. */
  readonly openDirectory?: (path: string) => Promise<number>;
}

/**
 * The in-process removal guard (vendor/fuse-napi/removal-guard.c), as this
 * module drives it. It owns the descriptors it is given.
 */
export interface RemovalGuard {
  addRoot(path: string, fd: number): number;
  removeRoot(path: string): boolean;
}

export interface NativeRootsStats {
  /** Native roots mounted right now, read from mountinfo. */
  readonly active: number;
  /** Mounts that succeeded since start. */
  readonly mounts: number;
  /** Mounts that were refused or failed verification. */
  readonly failures: number;
  /** Lazy detaches issued since start, by request or by the removal guard. */
  readonly detaches: number;
  /** Detaches the removal guard made so a removal or rename could go through. */
  readonly removalDetaches: number;
  /** The most recent failure, for the info endpoint. */
  readonly lastFailure: string | undefined;
}

export interface NativeRoots {
  /**
   * Mount `rel` if it is a native root. Fire-and-forget; never throws.
   * `created` says the directory was just made. A lookup (`created`
   * false) skips a parked root: one whose mount was refused, or one a
   * caller detached so it could remove it. Creating it again unparks it.
   */
  ensure(relativePath: string, created?: boolean): void;
  /** Ensure every native root that already exists on the backing disk. */
  scan(): void;
  /** Resolves once every mount started so far has settled. For tests. */
  settled(): Promise<void>;
  /**
   * Lazily detach one native root, or all of them, on a caller's request,
   * and park them so a lookup does not mount them straight back while the
   * caller removes or renames them. Never throws.
   */
  detach(relativePath?: string): Promise<string[]>;
  /** Lazily detach everything, at startup and shutdown. Parks nothing. */
  detachAll(): Promise<string[]>;
  /** Whether `rel` is a native root: a local-only directory whose parent is synced. */
  isRoot(relativePath: string): boolean;
  /**
   * Hands every mounted root, now and from here on, to the removal guard.
   * Call once the guard has started.
   */
  attachGuard(guard: RemovalGuard): Promise<void>;
  /**
   * The removal guard detached `target` so a removal or rename could go
   * through. Parks it, as a requested detach does.
   */
  guardDetached(target: string): void;
  stats(): NativeRootsStats;
}

export function createNativeRoots(options: NativeRootsOptions): NativeRoots {
  const root = trimTrailing(options.root);
  const mountPoint = trimTrailing(options.mountPoint) || "/";
  const unbindRoot =
    options.unbindRoot ??
    (async (targetRoot: string, rel: string) => {
      const { default: Fuse } = await import("fuse-napi");
      if (typeof Fuse.unbindRoot !== "function") return -38;
      return Fuse.unbindRoot(targetRoot, rel);
    });
  const bindRoot =
    options.bindRoot ??
    (async (sourceRoot: string, targetRoot: string, rel: string) => {
      const { default: Fuse } = await import("fuse-napi");
      if (typeof Fuse.bindRoot !== "function") return -38; // ENOSYS; never fall back to path mount.
      return Fuse.bindRoot(sourceRoot, targetRoot, rel);
    });
  const readMountinfo = options.mountinfo ?? (() => readFileSync("/proc/self/mountinfo", "utf8"));
  const lstat = options.lstat ?? ((path: string) => lstatSync(path));
  const lstatTarget = options.lstatTarget ?? ((path: string) => fsPromises.lstat(path));
  const readdir = options.readdir ?? ((path: string) => readdirSync(path));
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const active = options.active ?? (() => true);

  const inflight = new Map<string, Promise<void>>();
  let suspended = 0;
  // Roots a lookup must not mount: refused ones, and ones a caller
  // detached on purpose. Creating the directory again unparks it.
  const parked = new Set<string>();
  let mounts = 0;
  let failures = 0;
  let detaches = 0;
  let lastFailure: string | undefined;
  let removalDetaches = 0;
  let guard: RemovalGuard | undefined;
  const openDirectory =
    options.openDirectory ??
    (async (path: string) => {
      const { default: Fuse } = await import("fuse-napi");
      if (typeof Fuse.openRoot !== "function") throw new Error("confined open unavailable");
      const fd = await Fuse.openRoot(mountPoint, stripSlashes(path.slice(mountPoint.length)));
      if (fd < 0) throw new Error(`confined open failed (${fd})`);
      return fd;
    });

  // Through the thread pool: the target is under the mount.
  const registerWithGuard = async (target: string): Promise<void> => {
    const attachedGuard = guard;
    if (attachedGuard === undefined) return;
    let fd: number;
    try {
      fd = await openDirectory(target);
    } catch {
      return; // Gone again; nothing to guard.
    }
    attachedGuard.addRoot(target, fd); // The guard owns the descriptor, even on failure.
  };

  const targetOf = (rel: string): string => join(mountPoint, rel);
  const relOf = (target: string): string => stripSlashes(target.slice(mountPoint.length));
  const sourceOf = (rel: string): string => join(root, rel);

  const isRoot = (relativePath: string): boolean => {
    const rel = stripSlashes(relativePath);
    if (rel === "") return false;
    return options.ignore.ignores(rel) && !options.ignore.ignores(parentOf(rel));
  };

  // Treat every mount strictly below the mount point as owned. The FUSE
  // mount itself sits at the mount point and is excluded.
  const owned = (): string[] => {
    let text: string;
    try {
      text = readMountinfo();
    } catch {
      return [];
    }
    const prefix = mountPoint === "/" ? "/" : `${mountPoint}/`;
    const targets: string[] = [];
    for (const line of text.split("\n")) {
      const field = line.split(" ")[4];
      if (field === undefined) continue;
      const target = unescapeMountinfo(field);
      if (target !== mountPoint && target.startsWith(prefix)) targets.push(target);
    }
    return targets;
  };

  const recordFailure = (rel: string, reason: string): void => {
    failures += 1;
    parked.add(rel);
    lastFailure = `${rel}: ${reason}`;
    // Once per process. A refused mount is refused for every root, and a
    // line per root would bury the log during an install.
    if (failures === 1) {
      warn(
        `computerd: could not mount native root ${rel} (${reason}); serving it through ` +
          `FUSE instead, which works but is slower. Further failures are counted in ` +
          `/__computerd/stats under localPaths.nativeRoots.`,
      );
    }
  };

  const stillThere = async (source: string, target: string): Promise<boolean> => {
    try {
      lstat(source);
      return (await lstatTarget(target)).isDirectory();
    } catch {
      return false;
    }
  };

  async function mountOne(rel: string): Promise<void> {
    const source = sourceOf(rel);
    const target = targetOf(rel);
    let sourceStat: { isDirectory(): boolean };
    try {
      // lstat, so a symlink at the root path is never mounted over.
      sourceStat = lstat(source);
    } catch {
      return; // Removed again before we got here.
    }
    if (!sourceStat.isDirectory()) return;
    if (owned().includes(target)) return;
    // The synced parent may not exist yet: after a restore with an
    // in-memory store, the host pushes it back later. That is "not yet",
    // not a failure; the first lookup after it arrives mounts the root.
    // Asynchronous, because the target is under the mount.
    try {
      if (!(await lstatTarget(target)).isDirectory()) return;
    } catch {
      return;
    }
    // Parked while we waited: the removal guard or a caller detached it so
    // it could be removed. Mounting now would put it back under them.
    if (parked.has(rel)) return;

    // The addon resolves both paths beneath pinned directory descriptors and
    // attaches a private cloned mount with move_mount. A JavaScript realpath
    // precheck or an external mount command cannot close this race.
    const bound = await bindRoot(root, mountPoint, rel);
    if (bound !== 0) {
      if (bound === -2 && !(await stillThere(source, target))) return; // ENOENT race
      recordFailure(rel, `confined bind failed (${bound})`);
      return;
    }
    // The helper checked the detached clone's identity before attaching it
    // through the pinned target descriptor. A rename can move that mount
    // after it returns; mountinfo then lists the new path.
    mounts += 1;
    await registerWithGuard(target);
  }

  const ensure = (relativePath: string, created = false): void => {
    if (!active() || suspended > 0) return;
    const rel = stripSlashes(relativePath);
    if (!isRoot(rel) || inflight.has(rel)) return;
    if (parked.has(rel)) {
      if (!created) return;
      parked.delete(rel);
    }
    const pending = mountOne(rel)
      .catch((error: unknown) => recordFailure(rel, String(error)))
      .finally(() => inflight.delete(rel));
    inflight.set(rel, pending);
  };

  // Walks the backing tree: synced ancestors of local paths exist there as
  // plain directories. Never descends into a local-only directory, so the
  // cost is the scaffolding, not the dependency tree.
  const walk = (relativePath: string, visit: (rel: string) => void): void => {
    const rel = stripSlashes(relativePath);
    let names: string[];
    try {
      names = readdir(rel === "" ? root : sourceOf(rel));
    } catch {
      return;
    }
    for (const name of names) {
      const child = rel === "" ? name : `${rel}/${name}`;
      if (isRoot(child)) {
        visit(child);
      } else if (!options.ignore.ignores(child)) {
        try {
          // A synced scaffold can be a symlink after restore. Never scan
          // through it into an unrelated directory (or a symlink cycle).
          if (lstat(sourceOf(child)).isDirectory()) walk(child, visit);
        } catch {
          // Removed or changed during the scan. The next lookup can retry.
        }
      }
    }
  };

  const settled = async (): Promise<void> => {
    while (inflight.size > 0) await Promise.all([...inflight.values()]);
  };

  const detachTargets = async (targets: string[]): Promise<string[]> => {
    const detached: string[] = [];
    // Deepest first, so a parent is never detached out from under a child.
    for (const target of [...targets].sort((a, b) => b.length - a.length)) {
      // Closes the guard's descriptor, which would otherwise keep the
      // detached mount alive.
      guard?.removeRoot(target);
      if ((await unbindRoot(mountPoint, relOf(target))) === 0) {
        detaches += 1;
        detached.push(target);
      }
    }
    return detached;
  };

  const detachAllTargets = async (park: boolean): Promise<string[]> => {
    // Prevent new binds while existing workers settle. A requested detach
    // parks roots; startup/shutdown cleanup leaves them available to scan.
    suspended += 1;
    try {
      if (park) for (const rel of inflight.keys()) parked.add(rel);
      await settled();
      const targets = owned();
      if (park) for (const target of targets) parked.add(relOf(target));
      return await detachTargets(targets);
    } finally {
      suspended -= 1;
    }
  };

  return {
    ensure,
    scan: () => {
      if (active()) walk("", (rel) => ensure(rel));
    },
    settled,
    detach: async (relativePath) => {
      if (relativePath === undefined) return detachAllTargets(true);
      const rel = stripSlashes(relativePath);
      if (isRoot(rel)) parked.add(rel);
      await inflight.get(rel);
      return detachTargets(owned().filter((target) => target === targetOf(rel)));
    },
    detachAll: () => detachAllTargets(false),
    isRoot,
    attachGuard: async (attached) => {
      guard = attached;
      await Promise.all(owned().map((target) => registerWithGuard(target)));
    },
    guardDetached: (target) => {
      parked.add(relOf(target));
      detaches += 1;
      removalDetaches += 1;
    },
    stats: () => ({
      active: owned().length,
      mounts,
      failures,
      detaches,
      removalDetaches,
      lastFailure,
    }),
  };
}

/** mountinfo escapes space, tab, newline, and backslash as octal. */
export function unescapeMountinfo(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function parentOf(rel: string): string {
  const parent = dirname(rel);
  return parent === "." ? "" : parent;
}

function stripSlashes(value: string): string {
  let out = value;
  while (out.startsWith("/")) out = out.slice(1);
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function trimTrailing(value: string): string {
  return value.replace(/\/+$/, "");
}
