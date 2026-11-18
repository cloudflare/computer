// Passthrough mounts: reads served live by a mount object.
//
// Every read of a path at or below a passthrough root goes to the
// mount registered for it (see passthrough-registry.ts) before any SQL
// reads the subtree; nothing under the root is ever stored. A path
// lands below a root by name or through symbolic links: resolveInode
// stops at the root either way and raises a passthroughUnsupported
// error naming the target, which the async entry points here catch to
// ask the mount instead. A directory that holds passthrough roots
// lists them beside its own entries, and a find or grep over it
// splices each mount's walk, one recursive readdir, into the store's
// walk where the root falls, reading no further than its limit.
//
// What a mount returns is checked before it is used: entry names must
// be normalized relative paths, stats well formed, a walk no longer
// than its limit, a file's body as long as its stat says. A reply that
// fails a check, or a mount method that throws anything but a
// WorkspaceFsError, fails that one operation with EIO.
//
// Every mount call gets an AbortSignal. It is aborted when the
// operation stops needing the call's result: a find or grep that
// reached its limit, a file stream its reader cancelled, a body read
// past the window it was asked for.
//
// Writes need nothing here: the roots are read-only mount roots to the
// guard in mount-guard.ts, which rejects writes at or below them, and
// recursive removal or renaming of a directory above them, with EROFS.
// Synchronous reads can't wait for a mount; they fail with ENOTSUP.

import { createWorkspaceError, isWorkspaceError, type WorkspaceFsError } from "../errors";
import { canonicalizePath } from "../path";
import type { Database } from "../storage";
import { pathOf } from "../sync/paths";
import {
  compareBytes,
  compareFoundPaths,
  compileFindFilters,
  compileGlob,
  type FindFilters,
  type FindOptions,
  find,
  isExcluded,
  iterateFoundEntries,
  type WorkspaceFoundEntry,
} from "./find";
import { type GrepOptions, grep, grepFiles, type WorkspaceGrepMatch } from "./grep";
import { ls } from "./ls";
import { mkdirForSyncParents } from "./mkdir";
import { invalidateReadOnlyMountCache } from "./mount-guard";
import {
  hasPassthroughMounts,
  type PassthroughSource,
  type PassthroughStat,
  type PassthroughTarget,
  passthroughRootsBelow,
  passthroughTargetOf,
  redirectOf,
  setPassthroughSources,
} from "./passthrough-registry";
import { type ReaddirOptions, readdir, type WorkspaceDirentResult } from "./readdir";
import { type ReadFileOptions, readFile, readWindow, validateReadWindow } from "./readFile";
import { readlink } from "./readlink";
import { resolveInode } from "./resolve";
import { lstat, stat, type WorkspaceStatResult } from "./stat";

// Most entries one recursive readdir may return. A longer reply fails
// the operation with EIO; a mount whose tree is bigger than it will
// list should throw instead.
export const PASSTHROUGH_WALK_LIMIT = 100_000;

// How much of a mount's error message an error carries.
const MAX_ERROR_MESSAGE = 1024;

interface WalkEntry extends PassthroughStat {
  path: string;
}

// A passthrough root below a store directory. `path` is the root as
// named under the directory asked for, which differs from `root` when
// that directory was reached through a symbolic link.
interface RootBelow {
  root: string;
  path: string;
  source: PassthroughSource;
}

// How to walk a directory: in a mount, or in the store with the roots
// below it spliced in.
type WalkPlan =
  | { kind: "mount"; target: PassthroughTarget }
  | { kind: "store"; roots: RootBelow[] };

// Register the passthrough mounts of one Database, replacing any
// registered before. Roots must be canonical absolute paths other than
// "/", none inside another; the caller checks them against its other
// mounts. Each root's parent directory is created when missing, so the
// root has somewhere to be listed; the root itself never gets a row.
export function registerPassthroughMounts(
  db: Database,
  mounts: ReadonlyMap<string, PassthroughSource>,
  now: () => number,
): void {
  const roots = [...mounts.keys()];
  for (const root of roots) {
    if (!root.startsWith("/") || canonicalizePath(root).path !== root) {
      throw new Error(
        `passthrough mount root must be a canonical absolute path: ${JSON.stringify(root)}`,
      );
    }
    if (root === "/") {
      throw new Error("a passthrough mount can't be at /: it would hide the whole store");
    }
    for (const other of roots) {
      if (other !== root && other.startsWith(`${root}/`)) {
        throw new Error(`mount roots must not nest: ${root} contains ${other}`);
      }
    }
  }
  setPassthroughSources(db, new Map());
  invalidateReadOnlyMountCache(db);
  for (const root of roots) {
    const parent = canonicalizePath(root).parentPath ?? "/";
    if (parent === "/") continue;
    const node = resolveInode(db, parent);
    if (node === null) {
      mkdirForSyncParents(db, parent, { recursive: true }, now);
    } else if (node.type !== "dir") {
      throw createWorkspaceError(
        "ENOTDIR",
        `passthrough mount at ${root}: parent is not a directory`,
        parent,
      );
    }
  }
  setPassthroughSources(db, mounts);
  invalidateReadOnlyMountCache(db);
}

// The passthrough mount serving `path` by name, if any. Throws EINVAL
// for a path the store would reject, like every other entry point.
export function passthroughTarget(db: Database, path: string): PassthroughTarget | undefined {
  if (!hasPassthroughMounts(db)) return undefined;
  return passthroughTargetOf(db, canonicalizePath(path).path);
}

// A passthrough root that listing the store directory at `path` would
// have to include, which a synchronous listing can't stat.
export function passthroughRootListedBy(db: Database, path: string): string | undefined {
  if (!hasPassthroughMounts(db)) return undefined;
  return rootsBelowDirectory(db, canonicalizePath(path).path, true)[0]?.root;
}

// --- Entry points -------------------------------------------------

export async function statWithPassthrough(
  db: Database,
  path: string,
  followSymlinks: boolean,
): Promise<WorkspaceStatResult> {
  const fromStore = () => (followSymlinks ? stat(db, path) : lstat(db, path));
  if (!hasPassthroughMounts(db)) return fromStore();
  return orMount(fromStore, (target) => statMount(target, idleSignal()));
}

export async function readlinkWithPassthrough(db: Database, path: string): Promise<string> {
  if (!hasPassthroughMounts(db)) return readlink(db, path);
  return orMount(
    () => readlink(db, path),
    async (target) => {
      await statMount(target, idleSignal());
      throw createWorkspaceError("EINVAL", `not a symlink: ${target.path}`, target.path);
    },
  );
}

export async function readdirWithPassthrough(
  db: Database,
  path: string,
  options: ReaddirOptions = {},
): Promise<WorkspaceDirentResult[]> {
  if (!hasPassthroughMounts(db)) return readdir(db, path, options);
  const { path: canonical } = canonicalizePath(path);
  let children: RootBelow[];
  try {
    children = rootsBelowDirectory(db, canonical, true);
  } catch (error) {
    const target = redirectOf(error);
    if (target === undefined) throw error;
    return page(await listMountDirectory(target, idleSignal()), options);
  }
  if (children.length === 0) return readdir(db, path, options);

  // A root shadows whatever the store has under its name.
  const prefix = prefixOf(canonical);
  const names = new Set(children.map((child) => child.path.slice(prefix.length)));
  const entries = readdir(db, path).filter((entry) => !names.has(entry.name));
  const roots = await Promise.all(
    children.map((child) =>
      listedRoot(canonical, { path: child.path, root: child.root, rel: "", source: child.source }),
    ),
  );
  for (const entry of roots) if (entry !== undefined) entries.push(entry);
  entries.sort((a, b) => compareBytes(a.name, b.name));
  return page(entries, options);
}

export async function readFileWithPassthrough(
  db: Database,
  path: string,
  optionsOrEncoding?: "utf8" | ReadFileOptions,
  signal?: AbortSignal,
): Promise<string | ReadableStream<Uint8Array>> {
  if (!hasPassthroughMounts(db)) return readFile(db, path, optionsOrEncoding as ReadFileOptions);
  const options = typeof optionsOrEncoding === "object" ? optionsOrEncoding : undefined;
  const wantString = optionsOrEncoding === "utf8" || options?.encoding === "utf8";
  const byteOffset = options?.byteOffset ?? 0;
  const byteLength = options?.byteLength;
  return orMount(
    () => readFile(db, path, optionsOrEncoding as ReadFileOptions),
    async (target) => {
      validateReadWindow(path, byteOffset, byteLength);
      const opened = await openMountFile(target, byteOffset, byteLength, signal);
      if (!wantString) return opened.stream;
      return new TextDecoder().decode(await collectBytes(opened, target.path));
    },
  );
}

// The bytes of a file served by a passthrough mount.
export async function readPassthroughFile(target: PassthroughTarget): Promise<Uint8Array> {
  return collectBytes(await openMountFile(target, 0, undefined), target.path);
}

export async function findWithPassthrough(
  db: Database,
  directory: string,
  pattern?: string,
  options: FindOptions = {},
): Promise<WorkspaceFoundEntry[]> {
  if (!hasPassthroughMounts(db)) return find(db, directory, pattern, options);
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("find limit must be a non-negative safe integer");
  }
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("find offset must be a non-negative safe integer");
  }
  if (limit === 0) return [];
  const { path: canonical } = canonicalizePath(directory);
  const plan = planWalk(db, canonical);
  if (plan.kind === "store" && plan.roots.length === 0) {
    return find(db, directory, pattern, options);
  }

  const controller = new AbortController();
  let finished = false;
  const out: WorkspaceFoundEntry[] = [];
  let seen = 0;
  try {
    for await (const entry of foundEntries(
      db,
      canonical,
      plan,
      pattern,
      options.exclude,
      controller.signal,
    )) {
      if (seen >= offset) {
        out.push(entry);
        if (out.length >= limit) return out;
      }
      seen += 1;
    }
    finished = true;
    return out;
  } finally {
    if (!finished) controller.abort();
  }
}

export async function lsWithPassthrough(db: Database, prefix: string): Promise<string[]> {
  if (!hasPassthroughMounts(db)) return ls(db, prefix);
  // ls does not follow symbolic links, so roots are found by name.
  const { path: canonical } = canonicalizePath(prefix);
  const target = passthroughTargetOf(db, canonical);
  if (target !== undefined) return mountFiles(target, idleSignal());
  const below = passthroughRootsBelow(db, canonical).map(({ root, source }): RootBelow => ({
    root,
    path: root,
    source,
  }));
  if (below.length === 0) return ls(db, prefix);

  const own = ls(db, prefix).filter((path) => !underAny(path, below));
  const mounted = await Promise.all(
    below.map(async ({ root, source }) => {
      try {
        return await mountFiles({ path: root, root, rel: "", source }, idleSignal());
      } catch (error) {
        reportSkipped(root, error);
        return [];
      }
    }),
  );
  return [...own, ...mounted.flat()].sort(compareBytes);
}

export async function grepWithPassthrough(
  db: Database,
  pattern: string,
  path: string,
  options: GrepOptions = {},
): Promise<WorkspaceGrepMatch[]> {
  if (!hasPassthroughMounts(db)) return grep(db, pattern, path, options);
  const { path: canonical } = canonicalizePath(path);
  const plan = planWalk(db, canonical);
  const controller = new AbortController();
  let files: Iterable<string> | AsyncIterable<string>;
  if (plan.kind === "mount") {
    const found = await statMount(plan.target, controller.signal);
    files = found.isFile
      ? [canonical]
      : filesOf(
          foundEntries(db, canonical, plan, options.include, options.exclude, controller.signal),
        );
  } else {
    if (plan.roots.length === 0) return grep(db, pattern, path, options);
    files = filesOf(
      foundEntries(db, canonical, plan, options.include, options.exclude, controller.signal),
    );
  }

  let exhausted = false;
  async function* tracked(): AsyncIterable<string> {
    for await (const file of files) yield file;
    exhausted = true;
  }
  try {
    return await grepFiles(pattern, tracked(), options, async (filePath) => {
      const stream = await readFileWithPassthrough(db, filePath, undefined, controller.signal);
      return stream as ReadableStream<Uint8Array>;
    });
  } finally {
    if (!exhausted) controller.abort();
  }
}

// --- Walks --------------------------------------------------------

function planWalk(db: Database, canonical: string): WalkPlan {
  try {
    return { kind: "store", roots: rootsBelowDirectory(db, canonical, false) };
  } catch (error) {
    const target = redirectOf(error);
    if (target === undefined) throw error;
    return { kind: "mount", target };
  }
}

// The passthrough roots below the store directory at `canonical`, by
// where it really is, or only those directly in it. None when it is
// missing or not a directory; throws passthroughUnsupported when it is
// in a mount.
function rootsBelowDirectory(db: Database, canonical: string, childrenOnly: boolean): RootBelow[] {
  const node = resolveInode(db, canonical);
  if (node?.type !== "dir") return [];
  const real = pathOf(db, node.inode) ?? canonical;
  const realPrefix = prefixOf(real);
  const shownPrefix = prefixOf(canonical);
  const out: RootBelow[] = [];
  for (const { root, source } of passthroughRootsBelow(db, real)) {
    const rest = root.slice(realPrefix.length);
    if (childrenOnly && rest.includes("/")) continue;
    out.push({ root, path: `${shownPrefix}${rest}`, source });
  }
  return out;
}

// What find yields for `canonical`, lazily: a mount's walk when the
// directory is in one, or the store's walk with each root below it
// spliced in where find's order puts it. A mount is walked only when
// the walk reaches its root, and not at all when its root can't
// match. A broken mount below the directory is left out; one the
// directory is in fails the walk.
async function* foundEntries(
  db: Database,
  canonical: string,
  plan: WalkPlan,
  pattern: string | undefined,
  exclude: string[] | undefined,
  signal: AbortSignal,
): AsyncGenerator<WorkspaceFoundEntry> {
  const filters = compileFindFilters(pattern, exclude);
  const prefix = prefixOf(canonical);
  if (plan.kind === "mount") {
    const walk = await walkMount(plan.target, signal);
    if (walk === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }
    yield* filterWalk(walk, prefix, filters);
    return;
  }

  const glob = globSegments(pattern);
  const roots = plan.roots
    .filter((root) => reachable(root.path.slice(prefix.length), filters, glob))
    .sort((a, b) => compareFoundPaths(a.path, b.path));
  let next = 0;
  for (const entry of iterateFoundEntries(db, canonical, pattern, exclude)) {
    while (next < roots.length && compareFoundPaths(roots[next].path, entry.path) < 0) {
      yield* rootEntries(roots[next], prefix, filters, signal);
      next += 1;
    }
    // A root shadows whatever the store has under its name.
    if (underAny(entry.path, plan.roots)) continue;
    yield entry;
  }
  for (; next < roots.length; next += 1) yield* rootEntries(roots[next], prefix, filters, signal);
}

async function* rootEntries(
  below: RootBelow,
  prefix: string,
  filters: FindFilters,
  signal: AbortSignal,
): AsyncGenerator<WorkspaceFoundEntry> {
  let walk: WalkEntry[] | null;
  try {
    walk = await walkMount(
      { path: below.path, root: below.root, rel: "", source: below.source },
      signal,
    );
  } catch (error) {
    reportSkipped(below.root, error);
    return;
  }
  if (walk === null) return;
  const rootRel = below.path.slice(prefix.length);
  if (filters.regex === undefined || filters.regex.test(rootRel)) {
    yield { path: below.path, type: "dir" };
  }
  yield* filterWalk(walk, prefix, filters);
}

async function* filesOf(entries: AsyncIterable<WorkspaceFoundEntry>): AsyncGenerator<string> {
  for await (const entry of entries) if (entry.type === "file") yield entry.path;
}

// Apply find's glob and exclusions to a walk in find's order. A
// directory that is excluded takes everything below it along.
function* filterWalk(
  walk: WalkEntry[],
  prefix: string,
  filters: FindFilters,
): Generator<WorkspaceFoundEntry> {
  const pruned = new Set<string>();
  for (const entry of walk) {
    const parent = entry.path.slice(0, entry.path.lastIndexOf("/"));
    const relativePath = entry.path.slice(prefix.length);
    if (pruned.has(parent) || isExcluded(filters, relativePath, entry.type)) {
      if (entry.type === "dir") pruned.add(entry.path);
      continue;
    }
    if (filters.regex === undefined || filters.regex.test(relativePath)) {
      yield { path: entry.path, type: entry.type };
    }
  }
}

// What a find glob says about the leading segments of what it can
// match: one matcher per segment up to the first that may span
// several ("**", or a brace that might hold a "/"), and whether that
// is all of it, so nothing deeper can match.
interface GlobSegments {
  matchers: RegExp[];
  exact: boolean;
}

function globSegments(pattern: string | undefined): GlobSegments {
  if (!pattern) return { matchers: [], exact: false };
  const matchers: RegExp[] = [];
  for (const segment of pattern.split("/")) {
    if (segment.includes("**") || segment.includes("{") || segment.includes("}")) {
      return { matchers, exact: false };
    }
    matchers.push(compileGlob(segment));
  }
  return { matchers, exact: true };
}

// Whether anything at or below a root, at `rootRel` below the walk's
// directory, can be found: no directory down to it is excluded, and
// each of its segments can match the glob's.
function reachable(rootRel: string, filters: FindFilters, glob: GlobSegments): boolean {
  const parts = rootRel.split("/");
  for (let index = 1; index <= parts.length; index += 1) {
    if (isExcluded(filters, parts.slice(0, index).join("/"), "dir")) return false;
  }
  if (glob.exact && parts.length > glob.matchers.length) return false;
  const shared = Math.min(parts.length, glob.matchers.length);
  for (let index = 0; index < shared; index += 1) {
    if (!glob.matchers[index].test(parts[index])) return false;
  }
  return true;
}

// A mount below the directory a walk was asked for failed. Leave it
// out so the rest of the walk still answers, and say so.
function reportSkipped(root: string, error: unknown): void {
  console.warn({
    message: "Passthrough mount left out of a walk",
    root,
    error: error instanceof Error ? error.message : String(error),
  });
}

function prefixOf(canonical: string): string {
  return canonical === "/" ? "/" : `${canonical}/`;
}

function underAny(path: string, roots: Array<{ path: string }>): boolean {
  return roots.some((root) => path === root.path || path.startsWith(`${root.path}/`));
}

function page<T>(entries: T[], options: ReaddirOptions): T[] {
  const limit = options.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new TypeError("readdir limit must be a non-negative safe integer");
  }
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("readdir offset must be a non-negative safe integer");
  }
  return entries.slice(offset, limit === undefined ? undefined : offset + limit);
}

// Run a store read; when it stops at a passthrough root, by name or
// through a link, ask the mount instead.
async function orMount<T>(
  fromStore: () => T | Promise<T>,
  fromMount: (target: PassthroughTarget) => Promise<T>,
): Promise<T> {
  try {
    return await fromStore();
  } catch (error) {
    const target = redirectOf(error);
    if (target === undefined) throw error;
    return fromMount(target);
  }
}

// --- Mount calls --------------------------------------------------

async function statMount(
  target: PassthroughTarget,
  signal: AbortSignal,
): Promise<WorkspaceStatResult> {
  const reply = await ask(target, "stat", () => target.source.stat(target.rel, { signal }));
  if (reply === null || reply === undefined) {
    throw createWorkspaceError("ENOENT", `no such path: ${target.path}`, target.path);
  }
  const checked = checkStat(target, "stat", reply);
  if (target.rel === "" && checked.type !== "dir") {
    throw badReply(target, "stat", "a file for the mount root");
  }
  return statResult(canonicalizePath(target.path).name, checked);
}

// The entry a mount root gets in its parent's listing. A root its
// mount says is missing is left out; one whose stat fails is still
// listed, so one broken mount doesn't hide its siblings, and the
// failure surfaces when something reads below it.
async function listedRoot(
  parentPath: string,
  target: PassthroughTarget,
): Promise<WorkspaceDirentResult | undefined> {
  let mtime = 0;
  try {
    mtime = (await statMount(target, idleSignal())).mtime;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
  }
  return {
    name: canonicalizePath(target.root).name,
    parentPath,
    size: 0,
    mtime,
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
  };
}

async function listMountDirectory(
  target: PassthroughTarget,
  signal: AbortSignal,
): Promise<WorkspaceDirentResult[]> {
  const reply = await ask(target, "readdir", () => target.source.readdir(target.rel, { signal }));
  if (reply === null || reply === undefined) {
    throw createWorkspaceError("ENOENT", `no such path: ${target.path}`, target.path);
  }
  if (!Array.isArray(reply)) throw badReply(target, "readdir", "a listing that is not an array");
  const seen = new Set<string>();
  const entries: WorkspaceDirentResult[] = [];
  for (const item of reply as unknown[]) {
    const name = entryName(target, item, false);
    if (seen.has(name)) throw badReply(target, "readdir", `${JSON.stringify(name)} twice`);
    seen.add(name);
    const checked = checkStat(target, "readdir", item, name);
    entries.push({
      name,
      parentPath: target.path,
      size: checked.size,
      mtime: checked.mtime,
      isFile: checked.type === "file",
      isDirectory: checked.type === "dir",
      isSymbolicLink: false,
    });
  }
  return entries.sort((a, b) => compareBytes(a.name, b.name));
}

// Every entry below a mount directory, from one recursive readdir, in
// find's order. null when the mount says the directory is missing.
async function walkMount(
  target: PassthroughTarget,
  signal: AbortSignal,
): Promise<WalkEntry[] | null> {
  const reply = await ask(target, "readdir", () =>
    target.source.readdir(target.rel, { recursive: true, limit: PASSTHROUGH_WALK_LIMIT, signal }),
  );
  if (reply === null || reply === undefined) return null;
  if (!Array.isArray(reply)) throw badReply(target, "readdir", "a listing that is not an array");
  if (reply.length > PASSTHROUGH_WALK_LIMIT) {
    throw badReply(
      target,
      "readdir",
      `${reply.length} entries, more than the limit of ${PASSTHROUGH_WALK_LIMIT}`,
    );
  }
  const types = new Map<string, "file" | "dir">();
  const checked: Array<PassthroughStat & { name: string }> = [];
  for (const item of reply as unknown[]) {
    const name = entryName(target, item, true);
    if (types.has(name)) throw badReply(target, "readdir", `${JSON.stringify(name)} twice`);
    const entry = checkStat(target, "readdir", item, name);
    types.set(name, entry.type);
    checked.push({ ...entry, name });
  }
  for (const { name } of checked) {
    const slash = name.lastIndexOf("/");
    if (slash === -1) continue;
    const parent = types.get(name.slice(0, slash));
    if (parent === undefined) {
      throw badReply(target, "readdir", `${JSON.stringify(name)} without its parent directory`);
    }
    if (parent !== "dir") {
      throw badReply(target, "readdir", `${JSON.stringify(name)} below a file`);
    }
  }
  const base = target.path === "/" ? "" : target.path;
  return checked
    .map(({ name, ...entry }) => ({ ...entry, path: `${base}/${name}` }))
    .sort((a, b) => compareFoundPaths(a.path, b.path));
}

async function mountFiles(target: PassthroughTarget, signal: AbortSignal): Promise<string[]> {
  let walk: WalkEntry[] | null;
  try {
    walk = await walkMount(target, signal);
  } catch (error) {
    // ls of a file lists the file.
    if ((error as { code?: unknown }).code !== "ENOTDIR") throw error;
    return (await statMount(target, signal)).isFile ? [target.path] : [];
  }
  return (walk ?? []).filter((entry) => entry.type === "file").map((entry) => entry.path);
}

interface OpenedFile {
  stream: ReadableStream<Uint8Array>;
  // Bytes the stream delivers: the window, cut to the stated size.
  length: number;
}

async function openMountFile(
  target: PassthroughTarget,
  byteOffset: number,
  byteLength: number | undefined,
  parent?: AbortSignal,
): Promise<OpenedFile> {
  if (target.rel === "") {
    throw createWorkspaceError("EISDIR", `path is a directory: ${target.path}`, target.path);
  }
  const controller = linkedController(parent);
  const signal = controller.signal;
  const ranged = byteOffset > 0 || byteLength !== undefined;
  const range = { offset: byteOffset, ...(byteLength === undefined ? {} : { length: byteLength }) };
  const reply = await ask(target, "readFile", () =>
    target.source.readFile(target.rel, ranged ? { range, signal } : { signal }),
  );
  if (reply === null || reply === undefined) {
    throw createWorkspaceError("ENOENT", `no such file: ${target.path}`, target.path);
  }
  const body = (reply as { body?: unknown }).body as ReadableStream<Uint8Array> | undefined;
  if (typeof body?.getReader !== "function") {
    throw badReply(target, "readFile", "no body stream");
  }
  const abandon = () => {
    discard(body);
    controller.abort();
  };
  let checked: PassthroughStat;
  try {
    checked = checkStat(target, "readFile", (reply as { stat?: unknown }).stat);
  } catch (error) {
    abandon();
    throw error;
  }
  if (checked.type === "dir") {
    abandon();
    throw createWorkspaceError("EISDIR", `path is a directory: ${target.path}`, target.path);
  }
  const bodyOffset = (reply as { offset?: unknown }).offset;
  if (typeof bodyOffset !== "number" || !Number.isSafeInteger(bodyOffset) || bodyOffset < 0) {
    abandon();
    throw badReply(target, "readFile", `an invalid offset ${String(bodyOffset)}`);
  }
  const { start, end } = readWindow(checked.size, byteOffset, byteLength);
  // Nothing to read, at or past the end by the stat: don't drain a
  // body that may hold the whole file.
  if (start === end) {
    abandon();
    return { stream: emptyStream(), length: 0 };
  }
  if (bodyOffset > start) {
    abandon();
    throw badReply(target, "readFile", `data from byte ${bodyOffset}, past the ${start} asked for`);
  }
  return {
    stream: windowedBody(target, body, bodyOffset, start, end, checked.size, controller),
    length: end - start,
  };
}

// The bytes [start, end) of a file whose body starts at `bodyOffset`.
// Bytes before `start` are skipped, and the body is cancelled once
// `end` is reached. A body read to its end must stop exactly at the
// size the mount's stat gave, and none may run past it.
function windowedBody(
  target: PassthroughTarget,
  body: ReadableStream<Uint8Array>,
  bodyOffset: number,
  start: number,
  end: number,
  size: number,
  controller: AbortController,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let position = bodyOffset;
  const stop = (reason?: unknown): void => {
    reader.cancel(reason).catch(() => {});
    controller.abort(reason);
  };
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (failure) {
          controller.abort(failure);
          throw mountFailure(target, "readFile", failure);
        }
        if (chunk.done) {
          if (position < end) {
            controller.abort();
            throw badReply(
              target,
              "readFile",
              `${position - bodyOffset} bytes from byte ${bodyOffset} of a file its stat says has ${size}`,
            );
          }
          stream.close();
          return;
        }
        const value: unknown = chunk.value;
        if (!ArrayBuffer.isView(value)) {
          const failure = badReply(target, "readFile", "a body chunk that is not bytes");
          stop(failure);
          throw failure;
        }
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const chunkStart = position;
        position += bytes.byteLength;
        if (position > size) {
          const failure = badReply(
            target,
            "readFile",
            `more bytes than the ${size} its stat says the file has`,
          );
          stop(failure);
          throw failure;
        }
        const from = Math.max(start, chunkStart) - chunkStart;
        const to = Math.min(end, position) - chunkStart;
        if (to > from) stream.enqueue(bytes.subarray(from, to));
        if (position >= end && end < size) {
          // The rest is past the window; there is nothing to check it
          // against without reading it.
          stop();
          stream.close();
          return;
        }
        if (to > from) return;
      }
    },
    cancel(reason) {
      stop(reason);
    },
  });
}

// --- Checks -------------------------------------------------------

async function ask<T>(target: PassthroughTarget, op: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw mountFailure(target, op, error);
  }
}

// A WorkspaceFsError from a mount keeps its code; anything else it
// throws becomes EIO. Either way the error is rebuilt here, its
// message cut to a size and its path the one asked for.
function mountFailure(target: PassthroughTarget, op: string, error: unknown): WorkspaceFsError {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = "unknown error";
  }
  if (message.length > MAX_ERROR_MESSAGE) message = `${message.slice(0, MAX_ERROR_MESSAGE)}…`;
  if (isWorkspaceError(error)) return createWorkspaceError(error.code, message, target.path);
  return createWorkspaceError(
    "EIO",
    `passthrough mount at ${target.root}: ${op} failed: ${message}`,
    target.path,
  );
}

function badReply(target: PassthroughTarget, op: string, what: string): WorkspaceFsError {
  return createWorkspaceError(
    "EIO",
    `passthrough mount at ${target.root}: ${op} returned ${what}`,
    target.path,
  );
}

function checkStat(
  target: PassthroughTarget,
  op: string,
  value: unknown,
  name?: string,
): PassthroughStat {
  const what = name === undefined ? "a stat" : `a stat for ${JSON.stringify(name)}`;
  if (typeof value !== "object" || value === null) {
    throw badReply(target, op, `${what} that is not an object`);
  }
  const { type, size, mtime, mode } = value as Partial<Record<keyof PassthroughStat, unknown>>;
  if (type !== "file" && type !== "dir") {
    throw badReply(target, op, `${what} with type ${JSON.stringify(type)}`);
  }
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw badReply(target, op, `${what} with size ${String(size)}`);
  }
  if (typeof mtime !== "number" || !Number.isFinite(mtime)) {
    throw badReply(target, op, `${what} with mtime ${String(mtime)}`);
  }
  if (typeof mode !== "number" || !Number.isSafeInteger(mode) || mode < 0) {
    throw badReply(target, op, `${what} with mode ${String(mode)}`);
  }
  return { type, size: type === "dir" ? 0 : size, mtime, mode: mode & 0o7777 };
}

// A normalized relative name: no empty, "." or ".." segment, no leading
// or trailing "/", no backslash or NUL. Only a recursive listing may
// name something below a subdirectory.
function entryName(target: PassthroughTarget, item: unknown, nested: boolean): string {
  const name =
    typeof item === "object" && item !== null ? (item as { name?: unknown }).name : undefined;
  const valid =
    typeof name === "string" &&
    name.length > 0 &&
    !name.includes("\0") &&
    !name.includes("\\") &&
    (nested || !name.includes("/")) &&
    name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
  if (!valid) {
    throw badReply(
      target,
      "readdir",
      `an invalid entry name ${JSON.stringify(name) ?? String(name)}`,
    );
  }
  return name as string;
}

function statResult(name: string, value: PassthroughStat): WorkspaceStatResult {
  return {
    name,
    inode: 0,
    mode: value.mode,
    mtime: value.mtime,
    size: value.size,
    isFile: value.type === "file",
    isDirectory: value.type === "dir",
    isSymbolicLink: false,
  };
}

// --- Streams and signals ------------------------------------------

// A signal for a mount call nothing abandons halfway: a stat or a
// listing is wanted until it answers.
function idleSignal(): AbortSignal {
  return new AbortController().signal;
}

// A controller of its own, aborted with `parent` too.
function linkedController(parent: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (parent === undefined) return controller;
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
  return controller;
}

function discard(body: ReadableStream<Uint8Array>): void {
  try {
    body.cancel().catch(() => {});
  } catch {
    // A locked or broken stream: nothing more to release.
  }
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

// Read an opened file whole, holding no more than the bytes it says it
// delivers, whatever the mount sends.
async function collectBytes(opened: OpenedFile, path: string): Promise<Uint8Array> {
  const out = new Uint8Array(opened.length);
  const reader = opened.stream.getReader();
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.byteLength > out.byteLength) {
        await reader.cancel();
        throw createWorkspaceError(
          "EIO",
          `read more than the ${out.byteLength} bytes expected`,
          path,
        );
      }
      out.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return size === out.byteLength ? out : out.subarray(0, size);
}
