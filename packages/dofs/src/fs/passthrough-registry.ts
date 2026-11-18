// Passthrough mount registry.
//
// A passthrough mount serves a subtree from an object the caller hands
// over in memory each time it opens the store, rather than from rows in
// vfs_nodes. The registry maps one Database to its passthrough roots.
// It is kept apart from passthrough.ts, which implements the reads,
// because the read-only mount guard and resolveInode consult it and
// passthrough.ts imports both.
//
// Nothing here is persisted: a Database opened without the mounts has
// none, and the paths under their roots are gone with them.

import { createWorkspaceError, type WorkspaceFsError } from "../errors";
import type { Database } from "../storage";

// What a passthrough mount reports for one path.
export interface PassthroughStat {
  type: "file" | "dir";
  // Bytes. 0 for directories.
  size: number;
  // Milliseconds since the epoch, 0 when unknown.
  mtime: number;
  // Permission bits, such as 0o644.
  mode: number;
}

export interface PassthroughDirent extends PassthroughStat {
  // Relative to the directory read. With `recursive` it may contain
  // "/", parents listed before their children.
  name: string;
}

export interface PassthroughReadResult {
  stat: PassthroughStat;
  body: ReadableStream<Uint8Array>;
  // Byte of the file where `body` starts. A source that can't seek
  // returns 0 and the whole file; the reader skips and cuts.
  offset: number;
}

// The read surface of a passthrough mount. Paths are relative to the
// mount root: "" is the root, "a/b.md" a file below it. null means the
// path does not exist. A thrown WorkspaceFsError (ENOTDIR from readdir
// of a file, say) reaches the caller with its code; anything else
// thrown becomes EIO. A recursive readdir returns at most `limit`
// entries, or throws. Every call gets a signal, aborted when the
// operation no longer needs its result.
export interface PassthroughSource {
  stat(path: string, options?: { signal?: AbortSignal }): Promise<PassthroughStat | null>;
  readdir(
    path: string,
    options?: { recursive?: boolean; limit?: number; signal?: AbortSignal },
  ): Promise<PassthroughDirent[] | null>;
  readFile(
    path: string,
    options?: { range?: { offset: number; length?: number }; signal?: AbortSignal },
  ): Promise<PassthroughReadResult | null>;
}

// A path at or below a passthrough root, and where it lands.
export interface PassthroughTarget {
  // The canonical absolute path asked for. Through a symbolic link it
  // is not below `root`; results and errors are named after it.
  path: string;
  root: string;
  // `path` relative to `root`; "" for the root itself.
  rel: string;
  source: PassthroughSource;
}

interface Registry {
  readonly sources: ReadonlyMap<string, PassthroughSource>;
  readonly roots: readonly string[];
}

const registries = new WeakMap<Database, Registry>();

// Replace the passthrough mounts registered for `db`. Keyed by the
// Database object, so a second Database over the same storage starts
// with none. Callers go through registerPassthroughMounts in
// passthrough.ts, which validates the roots first.
export function setPassthroughSources(
  db: Database,
  sources: ReadonlyMap<string, PassthroughSource>,
): void {
  if (sources.size === 0) {
    registries.delete(db);
    return;
  }
  registries.set(db, { sources: new Map(sources), roots: [...sources.keys()] });
}

export function hasPassthroughMounts(db: Database): boolean {
  return registries.has(db);
}

export function passthroughRoots(db: Database): readonly string[] {
  return registries.get(db)?.roots ?? [];
}

// The passthrough mount serving a canonical path, if any.
export function passthroughTargetOf(
  db: Database,
  canonical: string,
): PassthroughTarget | undefined {
  const registry = registries.get(db);
  if (registry === undefined) return undefined;
  for (const root of registry.roots) {
    if (canonical === root) {
      return {
        path: canonical,
        root,
        rel: "",
        source: registry.sources.get(root) as PassthroughSource,
      };
    }
    if (canonical.startsWith(`${root}/`)) {
      return {
        path: canonical,
        root,
        rel: canonical.slice(root.length + 1),
        source: registry.sources.get(root) as PassthroughSource,
      };
    }
  }
  return undefined;
}

// Passthrough roots strictly below a canonical directory, with their
// sources.
export function passthroughRootsBelow(
  db: Database,
  canonical: string,
): Array<{ root: string; source: PassthroughSource }> {
  const registry = registries.get(db);
  if (registry === undefined) return [];
  const prefix = canonical === "/" ? "/" : `${canonical}/`;
  const out: Array<{ root: string; source: PassthroughSource }> = [];
  for (const root of registry.roots) {
    if (root !== canonical && root.startsWith(prefix)) {
      out.push({ root, source: registry.sources.get(root) as PassthroughSource });
    }
  }
  return out;
}

// The path below a target's root that it lands on.
export function realPathOf(target: PassthroughTarget): string {
  return target.rel === "" ? target.root : `${target.root}/${target.rel}`;
}

// Errors raised because a path needs a passthrough mount that a
// synchronous caller can't wait for, mapped to the mount target when
// there is one. The async entry points catch them and ask the mount;
// writers turn them into EROFS.
const unsupported = new WeakMap<object, PassthroughTarget | null>();

export function passthroughUnsupported(
  path: string,
  root: string,
  target?: PassthroughTarget,
): WorkspaceFsError {
  const error = createWorkspaceError(
    "ENOTSUP",
    `passthrough mount at ${root} can't be read synchronously`,
    path,
  );
  unsupported.set(error, target ?? null);
  return error;
}

export function isPassthroughUnsupported(error: unknown): error is WorkspaceFsError {
  return typeof error === "object" && error !== null && unsupported.has(error);
}

// The mount target a passthroughUnsupported error was raised for.
export function redirectOf(error: unknown): PassthroughTarget | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return unsupported.get(error) ?? undefined;
}

// A write that ran into a passthrough root, through a link the guard
// couldn't see, fails as a write there does: with EROFS. Other errors
// are returned as they are.
export function asReadOnly(error: unknown): unknown {
  if (!isPassthroughUnsupported(error)) return error;
  const target = redirectOf(error);
  const root = target?.root ?? "a passthrough mount";
  return createWorkspaceError("EROFS", `read-only mount at ${root}: cannot modify`, error.path);
}
