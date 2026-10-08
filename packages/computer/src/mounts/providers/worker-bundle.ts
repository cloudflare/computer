// WorkerBundle: an eager, read-only mount over a directory that ships
// inside the Worker's own upload.
//
// With nodejs_compat, workerd exposes every module in the upload as a
// read-only file under /bundle, readable through node:fs. A module's
// name is its path, so a directory survives only when the toolchain
// uploads each file as its own module under its relative path:
// wrangler does that for files matched by `rules` when
// `find_additional_modules` is on, and @cloudflare/computer/vite does
// it for Vite builds. A file imported from code is renamed to a
// content hash instead, so it can't be found by path.
//
// All node:fs calls in workerd are synchronous under the hood, so the
// provider uses the sync API throughout. That keeps WorkerBundle()
// itself synchronous, which MountFactory requires, while still letting
// it check the directory and compute a version at construction.
//
// The mount is always read-only. The deployment owns these files, so
// there is nowhere to write changes back to, and a redeploy replaces
// the copy (see `version` below).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

import type { EagerMount, MountWriteAPI } from "../types.js";

export interface WorkerBundleEntry {
  // Relative to the bundled directory, forward slashes, no leading slash.
  readonly path: string;
  readonly type: "file" | "dir";
}

export interface WorkerBundleOptions {
  // Return false to skip an entry. Skipping a directory skips its
  // whole subtree, and skipped entries don't count toward the version.
  filter?: (entry: WorkerBundleEntry) => boolean;
  // workerd's file system has no permission bits, so every bundled file
  // reads back the same way and scripts lose their executable bit.
  // Return a mode to set one, or undefined for the default: 0o755 for
  // files that start with "#!", 0o644 otherwise.
  fileMode?: (path: string, bytes: Uint8Array) => number | undefined;
  // Compared by the mount indexer with the version recorded at the last
  // index; a mismatch replaces the subtree. Defaults to a SHA-256 of the
  // included paths, modes and bytes. Pass a string, such as a build id,
  // to skip hashing a large tree, or false to index once per store.
  version?: string | false;
  maxBytes?: number;
  maxEntries?: number;
}

// Lets tests point the provider at a stand-in for /bundle. Not
// exported from the package.
export interface WorkerBundleInternals {
  bundleDir: string;
}

const DEFAULT_BUNDLE_DIR = "/bundle";
// Under `vite dev` the Worker runs through Vite's module runner, and
// /bundle holds only the runner's own modules, this one among them.
// None of the project's files are there, so its presence turns a
// confusing "does not exist" into an explanation.
const VITE_DEV_MARKER = "__VITE_WORKER_ENTRY__";

// /bundle can't change while an isolate is alive, so a hash computed
// once holds for every durable object the isolate hosts. Keyed by root
// plus the source text of filter and fileMode, which change the result.
// A filter that closes over per-session values gets the same key for
// different results, so those callers should pass an explicit version.
const versionCache = new Map<string, string>();

export function WorkerBundle(path: string, options: WorkerBundleOptions = {}): EagerMount {
  return createWorkerBundle(path, options, { bundleDir: DEFAULT_BUNDLE_DIR });
}

export function createWorkerBundle(
  path: string,
  options: WorkerBundleOptions,
  internals: WorkerBundleInternals,
): EagerMount {
  const root = resolveBundlePath(path, internals.bundleDir);
  assertDirectory(root, internals.bundleDir);

  const filter = options.filter ?? (() => true);
  const fileMode = (relPath: string, bytes: Uint8Array): number =>
    options.fileMode?.(relPath, bytes) ?? defaultFileMode(bytes);

  return {
    kind: "worker-bundle",
    strategy: "eager",
    mode: "read-only",
    maxBytes: options.maxBytes,
    maxEntries: options.maxEntries,
    version: resolveVersion(root, options, filter, fileMode),
    async materialize(api: MountWriteAPI): Promise<void> {
      for (const entry of walk(root, "", filter)) {
        const target = `${api.root}/${entry.path}`;
        if (entry.type === "dir") {
          await api.mkdir(target);
          continue;
        }
        const bytes = readBytes(`${root}/${entry.path}`);
        await api.writeFile(target, singleChunk(bytes), fileMode(entry.path, bytes));
      }
    },
  };
}

// Relative paths are read from /bundle. Absolute paths are used as-is,
// which is how tests and Node callers point at a directory on disk.
function resolveBundlePath(path: string, bundleDir: string): string {
  if (path.length === 0) {
    throw new Error("WorkerBundle: path must not be empty");
  }
  const segments = path.split("/");
  if (segments.includes("..")) {
    throw new Error(`WorkerBundle: path must not contain '..' segments: ${JSON.stringify(path)}`);
  }
  const absolute = path.startsWith("/") ? path : `${bundleDir}/${path}`;
  const normalized = absolute
    .split("/")
    .filter((s) => s.length > 0 && s !== ".")
    .join("/");
  return `/${normalized}`;
}

// A missing directory almost always means the wrangler rule or the
// Vite plugin is missing, so fail when the durable object starts, with
// the fix in the message, rather than mount an empty directory.
function assertDirectory(root: string, bundleDir: string): void {
  let isDirectory = false;
  let exists = false;
  try {
    const stat = statSync(root);
    exists = true;
    isDirectory = stat.isDirectory();
  } catch {
    exists = false;
  }
  if (isDirectory) return;
  if (exists) {
    throw new Error(`WorkerBundle: ${root} is not a directory`);
  }
  if (existsSync(`${bundleDir}/${VITE_DEV_MARKER}`)) {
    throw new Error(
      `WorkerBundle: ${root} is not available under \`vite dev\`, which does not upload ` +
        "project files into /bundle. Use `vite build && vite preview` or `wrangler dev`.",
    );
  }
  const name = root.startsWith(`${bundleDir}/`) ? root.slice(bundleDir.length + 1) : root;
  throw new Error(
    `WorkerBundle: ${root} does not exist. Files only appear under /bundle when they are ` +
      'uploaded as modules. With wrangler, set "find_additional_modules": true and add a rule ' +
      `such as { "type": "Data", "globs": ["${name}/**/*"] } in wrangler.jsonc. With Vite, add ` +
      `workerBundle({ dir: "src/${name}" }) from @cloudflare/computer/vite to your plugins.`,
  );
}

// Sorted so materialize() and the hash see entries in the same order
// on every run, whatever order readdirSync returns.
function* walk(
  root: string,
  rel: string,
  filter: (entry: WorkerBundleEntry) => boolean,
): Generator<WorkerBundleEntry> {
  const dir = rel === "" ? root : `${root}/${rel}`;
  const dirents = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const dirent of dirents) {
    const path = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
    if (dirent.isDirectory()) {
      const entry: WorkerBundleEntry = { path, type: "dir" };
      if (!filter(entry)) continue;
      yield entry;
      yield* walk(root, path, filter);
    } else if (dirent.isFile()) {
      const entry: WorkerBundleEntry = { path, type: "file" };
      if (filter(entry)) yield entry;
    }
  }
}

function resolveVersion(
  root: string,
  options: WorkerBundleOptions,
  filter: (entry: WorkerBundleEntry) => boolean,
  fileMode: (path: string, bytes: Uint8Array) => number,
): string | undefined {
  if (options.version === false) return undefined;
  if (typeof options.version === "string") return options.version;
  const key = [root, options.filter?.toString() ?? "", options.fileMode?.toString() ?? ""].join(
    "\0",
  );
  const cached = versionCache.get(key);
  if (cached !== undefined) return cached;
  const version = hashTree(root, filter, fileMode);
  versionCache.set(key, version);
  return version;
}

function hashTree(
  root: string,
  filter: (entry: WorkerBundleEntry) => boolean,
  fileMode: (path: string, bytes: Uint8Array) => number,
): string {
  const hash = createHash("sha256");
  for (const entry of walk(root, "", filter)) {
    hash.update(`${entry.type}\0${entry.path}\0`);
    if (entry.type === "file") {
      const bytes = readBytes(`${root}/${entry.path}`);
      // The mode is part of the copy, so a fileMode change has to
      // trigger a refresh just like a content change.
      hash.update(`${fileMode(entry.path, bytes).toString(8)}\0`);
      hash.update(bytes);
      hash.update("\0");
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function readBytes(absPath: string): Uint8Array {
  const buf = readFileSync(absPath);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function defaultFileMode(bytes: Uint8Array): number {
  return bytes[0] === 0x23 && bytes[1] === 0x21 ? 0o755 : 0o644;
}

// MountWriteAPI takes a stream so large sources can flow through
// without buffering. Bundled files are already in memory as modules,
// so one chunk is enough.
function singleChunk(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
