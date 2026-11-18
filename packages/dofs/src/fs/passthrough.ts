// Passthrough mounts: reads served live by a mount object.
//
// Every read of a path at or below a passthrough root goes to the
// mount registered for it (see passthrough-registry.ts) before any SQL
// runs; nothing under the root is ever stored. The functions here are
// the async read entry points of WorkspaceFilesystem and the provider:
// each routes a passthrough path to its mount and leaves every other
// path to the SQLite implementation it wraps. A directory that holds
// passthrough roots lists them beside its own entries, and a find, ls
// or grep over it walks each mount with one recursive readdir.
//
// What a mount returns is checked before it is used: entry names must
// be normalized relative paths, stats well formed, a file's body as
// long as its stat says. A reply that fails a check, or a mount method
// that throws anything but a WorkspaceFsError, fails that one
// operation with EIO.
//
// Writes need nothing here: the roots are read-only mount roots to the
// guard in mount-guard.ts, which rejects writes at or below them, and
// recursive removal or renaming of a directory above them, with EROFS.
// Synchronous reads can't wait for a mount, so resolveInode rejects a
// passthrough path with ENOTSUP.

import { createWorkspaceError, isWorkspaceError, type WorkspaceFsError } from "../errors";
import { canonicalizePath } from "../path";
import type { Database } from "../storage";
import {
  compareBytes,
  compareFoundPaths,
  compileFindFilters,
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
  setPassthroughSources,
} from "./passthrough-registry";
import { type ReaddirOptions, readdir, type WorkspaceDirentResult } from "./readdir";
import { type ReadFileOptions, readFile, readWindow, validateReadWindow } from "./readFile";
import { readlink } from "./readlink";
import { resolveInode } from "./resolve";
import { lstat, stat, type WorkspaceStatResult } from "./stat";

// Most entries one recursive readdir asks a mount for. A mount may
// throw or truncate past it; either way a find, ls or grep sees no
// more than it returns.
export const PASSTHROUGH_WALK_LIMIT = 100_000;

// How much of a mount's error message an EIO carries.
const MAX_ERROR_MESSAGE = 1024;

interface WalkEntry extends PassthroughStat {
  path: string;
}

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

// The passthrough mount serving `path`, if any. Throws EINVAL for a
// path the store would reject, like every other entry point.
export function passthroughTarget(db: Database, path: string): PassthroughTarget | undefined {
  if (!hasPassthroughMounts(db)) return undefined;
  return passthroughTargetOf(db, canonicalizePath(path).path);
}

// True when `path` is served by a passthrough mount or lists one.
export function touchesPassthrough(db: Database, path: string): boolean {
  if (!hasPassthroughMounts(db)) return false;
  const { path: canonical } = canonicalizePath(path);
  return (
    passthroughTargetOf(db, canonical) !== undefined ||
    passthroughRootsBelow(db, canonical).length > 0
  );
}

// --- Entry points -------------------------------------------------

export async function statWithPassthrough(
  db: Database,
  path: string,
  followSymlinks: boolean,
): Promise<WorkspaceStatResult> {
  const target = passthroughTarget(db, path);
  if (target === undefined) return followSymlinks ? stat(db, path) : lstat(db, path);
  return statMount(target);
}

export async function readlinkWithPassthrough(db: Database, path: string): Promise<string> {
  const target = passthroughTarget(db, path);
  if (target === undefined) return readlink(db, path);
  await statMount(target);
  throw createWorkspaceError("EINVAL", `not a symlink: ${target.path}`, target.path);
}

export async function readdirWithPassthrough(
  db: Database,
  path: string,
  options: ReaddirOptions = {},
): Promise<WorkspaceDirentResult[]> {
  if (!hasPassthroughMounts(db)) return readdir(db, path, options);
  const { path: canonical } = canonicalizePath(path);
  const target = passthroughTargetOf(db, canonical);
  if (target !== undefined) return page(await listMountDirectory(target), options);

  const prefix = canonical === "/" ? "/" : `${canonical}/`;
  const children = passthroughRootsBelow(db, canonical).filter(
    ({ root }) => !root.slice(prefix.length).includes("/"),
  );
  if (children.length === 0) return readdir(db, path, options);

  // A root shadows whatever the store has under its name.
  const names = new Set(children.map(({ root }) => root.slice(prefix.length)));
  const entries = readdir(db, path).filter((entry) => !names.has(entry.name));
  const roots = await Promise.all(
    children.map(({ root, source }) =>
      listedRoot(canonical, { path: root, root, rel: "", source }),
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
): Promise<string | ReadableStream<Uint8Array>> {
  const target = passthroughTarget(db, path);
  if (target === undefined) return readFile(db, path, optionsOrEncoding as ReadFileOptions);
  const options = typeof optionsOrEncoding === "object" ? optionsOrEncoding : undefined;
  const wantString = optionsOrEncoding === "utf8" || options?.encoding === "utf8";
  const byteOffset = options?.byteOffset ?? 0;
  const byteLength = options?.byteLength;
  validateReadWindow(path, byteOffset, byteLength);
  const stream = await readMountFile(target, byteOffset, byteLength);
  if (!wantString) return stream;
  return new TextDecoder().decode(await collectBytes(stream));
}

export async function findWithPassthrough(
  db: Database,
  directory: string,
  pattern?: string,
  options: FindOptions = {},
): Promise<WorkspaceFoundEntry[]> {
  if (!hasPassthroughMounts(db)) return find(db, directory, pattern, options);
  const { path: canonical } = canonicalizePath(directory);
  const target = passthroughTargetOf(db, canonical);
  const below = target === undefined ? passthroughRootsBelow(db, canonical) : [];
  if (target === undefined && below.length === 0) return find(db, directory, pattern, options);

  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError("find limit must be a non-negative safe integer");
  }
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("find offset must be a non-negative safe integer");
  }
  const entries = await collectFound(db, canonical, target, below, pattern, options.exclude);
  return entries.slice(offset, offset + limit);
}

export async function lsWithPassthrough(db: Database, prefix: string): Promise<string[]> {
  if (!hasPassthroughMounts(db)) return ls(db, prefix);
  const { path: canonical } = canonicalizePath(prefix);
  const target = passthroughTargetOf(db, canonical);
  if (target !== undefined) return mountFiles(target);
  const below = passthroughRootsBelow(db, canonical);
  if (below.length === 0) return ls(db, prefix);

  const own = ls(db, prefix).filter((path) => !underAny(path, below));
  const mounted = await Promise.all(
    below.map(({ root, source }) => mountFiles({ path: root, root, rel: "", source })),
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
  const target = passthroughTargetOf(db, canonical);
  const below = target === undefined ? passthroughRootsBelow(db, canonical) : [];
  if (target === undefined && below.length === 0) return grep(db, pattern, path, options);

  let files: string[];
  if (target !== undefined) {
    const found = await statMount(target);
    if (found.isFile) {
      files = [canonical];
    } else {
      const walk = (await walkMount(target)) ?? [];
      files = filterWalk(
        walk,
        prefixOf(canonical),
        compileFindFilters(options.include, options.exclude),
      )
        .filter((entry) => entry.type === "file")
        .map((entry) => entry.path);
    }
  } else {
    const node = resolveInode(db, canonical);
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }
    if (node.type === "file") return grep(db, pattern, path, options);
    files = (await collectFound(db, canonical, undefined, below, options.include, options.exclude))
      .filter((entry) => entry.type === "file")
      .map((entry) => entry.path);
  }
  return grepFiles(pattern, files, options, (filePath) => {
    const fileTarget = passthroughTargetOf(db, filePath);
    if (fileTarget === undefined) return readFile(db, filePath);
    return readMountFile(fileTarget, 0, undefined);
  });
}

// --- Mount calls --------------------------------------------------

async function statMount(target: PassthroughTarget): Promise<WorkspaceStatResult> {
  const reply = await ask(target, "stat", () => target.source.stat(target.rel));
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
    mtime = (await statMount(target)).mtime;
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

async function listMountDirectory(target: PassthroughTarget): Promise<WorkspaceDirentResult[]> {
  const reply = await ask(target, "readdir", () => target.source.readdir(target.rel));
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
async function walkMount(target: PassthroughTarget): Promise<WalkEntry[] | null> {
  const reply = await ask(target, "readdir", () =>
    target.source.readdir(target.rel, { recursive: true, limit: PASSTHROUGH_WALK_LIMIT }),
  );
  if (reply === null || reply === undefined) return null;
  if (!Array.isArray(reply)) throw badReply(target, "readdir", "a listing that is not an array");
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

async function mountFiles(target: PassthroughTarget): Promise<string[]> {
  let walk: WalkEntry[] | null;
  try {
    walk = await walkMount(target);
  } catch (error) {
    // ls of a file lists the file.
    if ((error as { code?: unknown }).code !== "ENOTDIR") throw error;
    return (await statMount(target)).isFile ? [target.path] : [];
  }
  return (walk ?? []).filter((entry) => entry.type === "file").map((entry) => entry.path);
}

async function readMountFile(
  target: PassthroughTarget,
  byteOffset: number,
  byteLength: number | undefined,
): Promise<ReadableStream<Uint8Array>> {
  if (target.rel === "") {
    throw createWorkspaceError("EISDIR", `path is a directory: ${target.path}`, target.path);
  }
  const ranged = byteOffset > 0 || byteLength !== undefined;
  const range = { offset: byteOffset, ...(byteLength === undefined ? {} : { length: byteLength }) };
  const reply = await ask(target, "readFile", () =>
    ranged ? target.source.readFile(target.rel, { range }) : target.source.readFile(target.rel),
  );
  if (reply === null || reply === undefined) {
    throw createWorkspaceError("ENOENT", `no such file: ${target.path}`, target.path);
  }
  const body = (reply as { body?: unknown }).body as ReadableStream<Uint8Array> | undefined;
  if (typeof body?.getReader !== "function") {
    throw badReply(target, "readFile", "no body stream");
  }
  let checked: PassthroughStat;
  try {
    checked = checkStat(target, "readFile", (reply as { stat?: unknown }).stat);
  } catch (error) {
    discard(body);
    throw error;
  }
  if (checked.type === "dir") {
    discard(body);
    throw createWorkspaceError("EISDIR", `path is a directory: ${target.path}`, target.path);
  }
  const bodyOffset = (reply as { offset?: unknown }).offset;
  if (typeof bodyOffset !== "number" || !Number.isSafeInteger(bodyOffset) || bodyOffset < 0) {
    discard(body);
    throw badReply(target, "readFile", `an invalid offset ${String(bodyOffset)}`);
  }
  const { start, end } = readWindow(checked.size, byteOffset, byteLength);
  if (bodyOffset > start) {
    discard(body);
    if (start === end) return emptyStream();
    throw badReply(target, "readFile", `data from byte ${bodyOffset}, past the ${start} asked for`);
  }
  return windowedBody(target, body, bodyOffset, start, end, checked.size);
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
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let position = bodyOffset;
  const fail = (failure: WorkspaceFsError): WorkspaceFsError => {
    reader.cancel(failure).catch(() => {});
    return failure;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw mountFailure(target, "readFile", error);
        }
        if (chunk.done) {
          if (position < end) {
            throw badReply(
              target,
              "readFile",
              `${position - bodyOffset} bytes from byte ${bodyOffset} of a file its stat says has ${size}`,
            );
          }
          controller.close();
          return;
        }
        const value: unknown = chunk.value;
        if (!ArrayBuffer.isView(value)) {
          throw fail(badReply(target, "readFile", "a body chunk that is not bytes"));
        }
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const chunkStart = position;
        position += bytes.byteLength;
        if (position > size) {
          throw fail(
            badReply(target, "readFile", `more bytes than the ${size} its stat says the file has`),
          );
        }
        const from = Math.max(start, chunkStart) - chunkStart;
        const to = Math.min(end, position) - chunkStart;
        if (to > from) controller.enqueue(bytes.subarray(from, to));
        if (position >= end && end < size) {
          // The rest is past the window; there is nothing to check it
          // against without reading it.
          reader.cancel().catch(() => {});
          controller.close();
          return;
        }
        if (to > from) return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

// --- Walks --------------------------------------------------------

// What find yields for `canonical`: a mount's walk when the directory
// is in one, or the store's walk with each passthrough root below it
// merged in, in find's order.
async function collectFound(
  db: Database,
  canonical: string,
  target: PassthroughTarget | undefined,
  below: Array<{ root: string; source: PassthroughSource }>,
  pattern: string | undefined,
  exclude: string[] | undefined,
): Promise<WorkspaceFoundEntry[]> {
  const filters = compileFindFilters(pattern, exclude);
  const prefix = prefixOf(canonical);
  if (target !== undefined) {
    const walk = await walkMount(target);
    if (walk === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }
    return filterWalk(walk, prefix, filters);
  }

  const own = [...iterateFoundEntries(db, canonical, pattern, exclude)].filter(
    (entry) => !underAny(entry.path, below),
  );
  const mounted = await Promise.all(
    below.map(async ({ root, source }): Promise<WorkspaceFoundEntry[]> => {
      const rootRel = root.slice(prefix.length);
      // An excluded directory on the way down prunes the mount with it.
      const parts = rootRel.split("/");
      for (let index = 1; index <= parts.length; index += 1) {
        if (isExcluded(filters, parts.slice(0, index).join("/"), "dir")) return [];
      }
      const walk = await walkMount({ path: root, root, rel: "", source });
      if (walk === null) return [];
      const out: WorkspaceFoundEntry[] = [];
      if (filters.regex === undefined || filters.regex.test(rootRel)) {
        out.push({ path: root, type: "dir" });
      }
      out.push(...filterWalk(walk, prefix, filters));
      return out;
    }),
  );
  return [...own, ...mounted.flat()].sort((a, b) => compareFoundPaths(a.path, b.path));
}

// Apply find's glob and exclusions to a walk in find's order. A
// directory that is excluded takes everything below it along.
function filterWalk(
  walk: WalkEntry[],
  prefix: string,
  filters: FindFilters,
): WorkspaceFoundEntry[] {
  const pruned = new Set<string>();
  const out: WorkspaceFoundEntry[] = [];
  for (const entry of walk) {
    const parent = entry.path.slice(0, entry.path.lastIndexOf("/"));
    const relativePath = entry.path.slice(prefix.length);
    if (pruned.has(parent) || isExcluded(filters, relativePath, entry.type)) {
      if (entry.type === "dir") pruned.add(entry.path);
      continue;
    }
    if (filters.regex === undefined || filters.regex.test(relativePath)) {
      out.push({ path: entry.path, type: entry.type });
    }
  }
  return out;
}

function prefixOf(canonical: string): string {
  return canonical === "/" ? "/" : `${canonical}/`;
}

function underAny(path: string, roots: Array<{ root: string }>): boolean {
  return roots.some(({ root }) => path === root || path.startsWith(`${root}/`));
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

// --- Checks -------------------------------------------------------

async function ask<T>(target: PassthroughTarget, op: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw mountFailure(target, op, error);
  }
}

// A WorkspaceFsError from a mount passes through; anything else it
// throws becomes EIO for this operation, with its message.
function mountFailure(target: PassthroughTarget, op: string, error: unknown): WorkspaceFsError {
  if (isWorkspaceError(error)) return error;
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = "unknown error";
  }
  if (message.length > MAX_ERROR_MESSAGE) message = `${message.slice(0, MAX_ERROR_MESSAGE)}…`;
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

// --- Streams ------------------------------------------------------

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

export async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
