import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

import type { EagerMount, MountWriteAPI } from "../types.js";

export interface WorkerBundleEntry {
  readonly path: string;
  readonly type: "file" | "dir";
}

export interface WorkerBundleOptions {
  filter?: (entry: WorkerBundleEntry) => boolean;
  fileMode?: (path: string, bytes: Uint8Array) => number | undefined;
  version?: string | false;
  maxBytes?: number;
  maxEntries?: number;
}

export interface WorkerBundleInternals {
  bundleDir: string;
}

const DEFAULT_BUNDLE_DIR = "/bundle";
const VITE_DEV_MARKER = "__VITE_WORKER_ENTRY__";

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

function singleChunk(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
