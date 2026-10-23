// The host half of file transfer: copy Workspace files into a container
// and container files back into the Workspace, with no sync protocol.
//
// Both directions send a manifest first, so only changed files cross
// the wire. Every file carries its Workspace revision, which computerd
// records as the version it holds:
//
//   push: POST /files/diff with the Workspace's files, then PUT /files
//         with the ones the container asked for.
//   pull: POST /files/pull with the patterns and the Workspace's copies
//         of them. The container answers with the files it changed, or
//         with a 409 listing files the Workspace changed too, in which
//         case nothing is written. After writing, POST /files/record
//         with the revisions the files were written at.
//
// The wire format and the container half are in
// @cloudflare/computer-rpc/files and computerd.

import {
  decodeFiles,
  encodeFiles,
  FILE_TRANSFER_CONTENT_TYPE,
  FILE_TRANSFER_ROUTES,
  type FileConflictResponse,
  type FileManifestEntry,
  FileTransferConflictError,
  normalizeTransferPattern,
  splitPatternBase,
} from "@cloudflare/computer-rpc/files";
import { compileGlob } from "@cloudflare/dofs";

/** The Workspace filesystem operations a transfer uses. */
export interface TransferFilesystem {
  find(directory: string, pattern?: string): Promise<Array<{ path: string; type: string }>>;
  lstat(path: string): Promise<{
    size: number;
    mtime: number;
    mode: number;
    isFile: boolean;
    isSymbolicLink: boolean;
  }>;
  /** The revision the path was last changed at; see WorkspaceFilesystem.revision. */
  revision(path: string): Promise<number>;
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  writeFile(
    path: string,
    content: ReadableStream<Uint8Array>,
    options?: { mode?: number },
  ): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

/** Sends an authenticated request to computerd. */
export type TransferFetch = (path: string, init: RequestInit) => Promise<Response>;

/** Options for {@link pushFiles} and {@link pullFiles}. */
export interface TransferOptions {
  /**
   * Patterns to leave out, in the same form as the patterns to copy. A
   * file is left out when it, or any directory above it, matches.
   */
  readonly exclude?: readonly string[];
  /**
   * Send every matching file, without comparing manifests first. On a
   * pull, this also overwrites Workspace files that changed in both
   * places, which a pull otherwise refuses.
   */
  readonly force?: boolean;
  /** Stops the transfer between files. */
  readonly signal?: AbortSignal;
}

/** What {@link pushFiles} copied. */
export interface PushResult {
  /** Files written to the container. */
  readonly pushed: number;
  /** Matching files the container already held unchanged. */
  readonly unchanged: number;
  /** Bytes written to the container. */
  readonly bytes: number;
}

/** What {@link pullFiles} copied. */
export interface PullResult {
  /** Files written to the Workspace. */
  readonly pulled: number;
  /** Bytes written to the Workspace. */
  readonly bytes: number;
  /** Files the Workspace refused, such as ones under a read-only mount. */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly error: string }>;
}

interface WorkspaceFile extends FileManifestEntry {
  readonly absolute: string;
  readonly mode: number;
  readonly rev: number;
}

/**
 * Copy the Workspace files under `root` that match `patterns` into the
 * container. Only files the container lacks, or holds with a different
 * size or modification time, are sent; pass `force` to send them all.
 * Files are added or replaced, never deleted.
 */
export async function pushFiles(
  fs: TransferFilesystem,
  fetch: TransferFetch,
  root: string,
  patterns: readonly string[],
  options: TransferOptions = {},
): Promise<PushResult> {
  const files = await collect(fs, root, patterns, options.exclude ?? []);
  options.signal?.throwIfAborted();
  let wanted = files;
  if (options.force !== true && files.length > 0) {
    const response = await fetch(FILE_TRANSFER_ROUTES.diff, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: files.map(manifestEntry) }),
    });
    const { want } = await readJSON<{ want: string[] }>(response, "push");
    const set = new Set(want);
    wanted = files.filter((file) => set.has(file.path));
  }
  if (wanted.length === 0) return { pushed: 0, unchanged: files.length, bytes: 0 };
  options.signal?.throwIfAborted();
  const body = encodeFiles(
    wanted.map((file) => ({
      header: {
        path: file.path,
        size: file.size,
        mtime: file.mtime,
        mode: file.mode,
        rev: file.rev,
      },
      body: () => {
        options.signal?.throwIfAborted();
        return fs.readFile(file.absolute);
      },
    })),
  );
  const response = await fetch(FILE_TRANSFER_ROUTES.put, {
    method: "PUT",
    headers: { "content-type": FILE_TRANSFER_CONTENT_TYPE },
    body,
    // Node's fetch needs this to send a stream; workerd ignores it.
    duplex: "half",
  } as RequestInit);
  const { written, bytes } = await readJSON<{ written: number; bytes: number }>(response, "push");
  return { pushed: written, unchanged: files.length - wanted.length, bytes };
}

/**
 * Copy the container files under `root` that match `patterns` into the
 * Workspace. Only files the container changed since they last matched
 * the Workspace are sent. Files are added or replaced, never deleted.
 *
 * @throws FileTransferConflictError, writing nothing, when a file the
 *   container changed was also changed in the Workspace since. Pass
 *   `force` to fetch every matching file and overwrite regardless.
 */
export async function pullFiles(
  fs: TransferFilesystem,
  fetch: TransferFetch,
  root: string,
  patterns: readonly string[],
  options: TransferOptions = {},
): Promise<PullResult> {
  const base = trimRoot(root);
  const globs = patterns.flatMap((pattern) => normalizeTransferPattern(pattern, base));
  const exclude = (options.exclude ?? []).flatMap((pattern) =>
    normalizeTransferPattern(pattern, base),
  );
  const have =
    options.force === true
      ? []
      : (await collect(fs, base, patterns, options.exclude ?? [])).map(manifestEntry);
  options.signal?.throwIfAborted();
  // Patterns go relative to the root, so the container resolves them
  // against its own root rather than trusting an absolute path.
  const response = await fetch(FILE_TRANSFER_ROUTES.pull, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ patterns: globs, exclude, have, force: options.force === true }),
  });
  if (response.status === 409 && isJSON(response)) {
    const { conflicts } = (await response.json()) as FileConflictResponse;
    throw new FileTransferConflictError(
      conflicts.map((conflict) => ({ ...conflict, path: joinRoot(base, conflict.path) })),
    );
  }
  await expectOk(response, "pull");
  if (response.body === null) throw new Error("pull: the container sent no body.");

  let pulled = 0;
  let bytes = 0;
  const skipped: Array<{ path: string; error: string }> = [];
  const written: Array<{ path: string; rev: number }> = [];
  const created = new Set<string>();
  for await (const incoming of decodeFiles(response.body)) {
    options.signal?.throwIfAborted();
    const target = joinRoot(base, incoming.header.path);
    try {
      const parent = target.slice(0, target.lastIndexOf("/")) || "/";
      if (!created.has(parent)) {
        await fs.mkdir(parent, { recursive: true });
        created.add(parent);
      }
      await fs.writeFile(target, incoming.body, { mode: incoming.header.mode });
      written.push({ path: incoming.header.path, rev: await fs.revision(target) });
      pulled += 1;
      bytes += incoming.header.size;
    } catch (error) {
      // The rest of the transfer is still good; the decoder discards
      // whatever of this file's body the write left unread.
      skipped.push({
        path: target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Tell the container which revision each file now has in the
  // Workspace, so the next pull compares against it. Without this, the
  // next pull would see the container's copies as unrecorded.
  if (written.length > 0) {
    const recorded = await fetch(FILE_TRANSFER_ROUTES.record, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: written }),
    });
    await readJSON<{ recorded: number }>(recorded, "pull");
  }
  return { pulled, bytes, skipped };
}

// The Workspace's regular files under `root` that match the patterns.
async function collect(
  fs: TransferFilesystem,
  root: string,
  patterns: readonly string[],
  exclude: readonly string[],
): Promise<WorkspaceFile[]> {
  const base = trimRoot(root);
  const prefix = base === "/" ? "/" : `${base}/`;
  const globs = patterns.flatMap((pattern) => normalizeTransferPattern(pattern, base));
  const excludes = exclude
    .flatMap((pattern) => normalizeTransferPattern(pattern, base))
    .map((glob) => compileGlob(glob));
  const found = new Map<string, WorkspaceFile>();
  for (const glob of globs) {
    // Start each walk at the glob's literal directory rather than the
    // root, so `dist/**` reads only dist.
    const split = splitPatternBase(glob);
    const directory = split.base === "" ? base : `${prefix}${split.base}`;
    let entries: Array<{ path: string; type: string }>;
    try {
      entries = await fs.find(directory, split.rest);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.type !== "file" || !entry.path.startsWith(prefix)) continue;
      const relative = entry.path.slice(prefix.length);
      if (found.has(relative) || excluded(relative, excludes)) continue;
      const stats = await fs.lstat(entry.path);
      if (!stats.isFile || stats.isSymbolicLink) continue;
      found.set(relative, {
        path: relative,
        absolute: entry.path,
        size: stats.size,
        mtime: Math.floor(stats.mtime),
        mode: stats.mode & 0o7777,
        rev: await fs.revision(entry.path),
      });
    }
  }
  return [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function manifestEntry(file: WorkspaceFile): FileManifestEntry {
  return { path: file.path, size: file.size, mtime: file.mtime, rev: file.rev };
}

function isJSON(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("application/json");
}

// Whether a path, or any directory above it, matches an exclusion.
function excluded(relative: string, excludes: readonly RegExp[]): boolean {
  if (excludes.length === 0) return false;
  const segments = relative.split("/");
  for (let i = 1; i <= segments.length; i += 1) {
    const prefix = segments.slice(0, i).join("/");
    if (excludes.some((regex) => regex.test(prefix))) return true;
  }
  return false;
}

function trimRoot(root: string): string {
  if (!root.startsWith("/")) throw new TypeError(`Transfer root must be absolute: ${root}`);
  const trimmed = root.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function joinRoot(root: string, relative: string): string {
  return root === "/" ? `/${relative}` : `${root}/${relative}`;
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function expectOk(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  const text = (await response.text().catch(() => "")).trim();
  if (response.status === 404) {
    throw new Error(
      `${operation}: the container's computerd does not serve file transfer. Rebuild the image with a newer computerd.`,
    );
  }
  throw new Error(`${operation} failed with ${response.status}${text ? `: ${text}` : ""}`);
}

async function readJSON<T>(response: Response, operation: string): Promise<T> {
  await expectOk(response, operation);
  return (await response.json()) as T;
}
