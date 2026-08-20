// WorkspaceFsAdapter — implements just-bash's IFileSystem against
// a WorkspaceFilesystemStub.
//
// The adapter is a thin façade. Operations that map one-for-one
// (writeFile, readdir, mkdir, rm, chmod, symlink, readlink, stat,
// lstat) forward directly. Operations the stub doesn't expose —
// appendFile, cp, mv, exists — synthesize from the available
// primitives. Hard links and utimes aren't supported: link throws
// ENOSYS so a script that depends on them fails loudly; utimes
// is a documented no-op because the store has no atime column.
//
// The adapter holds no state. A single instance is safe to reuse
// across exec calls; nothing prevents a fresh adapter per exec
// either.

import type {
  GrepOptions,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WorkspaceDirentResult,
  WorkspaceFoundEntry,
  WorkspaceGrepMatch,
  WorkspaceStatResult,
  WriteFileContent,
  WriteFileOptions,
} from "@cloudflare/dofs";

// The subset of WorkspaceFilesystemStub the adapter consumes.
// Declared structurally so tests can swap in a fake or a real stub
// without coupling the adapter to the cloudflare:workers RpcTarget
// base class. Production callers pass `workspace.stub().fs`; the
// shape matches that stub one-for-one.
export interface WorkspaceFs {
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string, options: ReadFileOptions): Promise<string | ReadableStream<Uint8Array>>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<WorkspaceStatResult>;
  statOrNull(path: string): Promise<WorkspaceStatResult | null>;
  lstat(path: string): Promise<WorkspaceStatResult>;
  lstatOrNull(path: string): Promise<WorkspaceStatResult | null>;
  readdir(path: string): Promise<WorkspaceDirentResult[]>;
  find(directory: string, pattern?: string): Promise<WorkspaceFoundEntry[]>;
  ls(prefix: string): Promise<string[]>;
  grep(pattern: string, path: string, options?: GrepOptions): Promise<WorkspaceGrepMatch[]>;
  readlink(path: string): Promise<string>;
  writeFile(path: string, content: WriteFileContent, options?: WriteFileOptions): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  rm(path: string, options?: RmOptions): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
}

// Matches the subset of just-bash's IFileSystem the adapter
// implements. Kept structural so the package compiles without
// resolving just-bash's type entry — the Worker entry point ships
// the real binding to Bash.
interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

type AdapterReadFileOptions = { encoding?: "utf8" | null } | "utf8" | null | undefined;

export class WorkspaceFsAdapter {
  readonly #fs: WorkspaceFs;

  // Directory-listing cache, populated by a single subtree read and
  // consulted only while a prefetch scope is open. See beginPrefetch.
  #prefetchDepth = 0;
  #prefetchRoot: string | undefined;
  #direntCache: Map<string, DirentEntry[]> | undefined;
  #prefetchLoad: Promise<void> | undefined;

  constructor(fs: WorkspaceFs) {
    this.#fs = fs;
  }

  // --- Directory prefetch ------------------------------------------
  //
  // just-bash's find and grep walk the tree with one
  // readdirWithFileTypes per directory. Each is an RPC to the
  // workspace, so a recursive command over a tree that includes
  // node_modules costs thousands of round-trips before any matching
  // work happens.
  //
  // A caller that is about to run such a walk can open a prefetch
  // scope: the adapter reads the whole subtree once via the
  // workspace's server-side find() and answers subsequent
  // readdirWithFileTypes calls from that snapshot.
  //
  // Correctness rules:
  //   * The cache lives only for the duration of the scope. Nothing
  //     persists between commands, so a later command never sees a
  //     stale tree.
  //   * Any mutation through the adapter drops the cache immediately,
  //     so a walk that writes (find -delete, a pipeline that edits
  //     files) re-reads rather than trusting the snapshot.
  //   * Paths outside the prefetched root fall through to a direct
  //     listing.
  //
  // Scopes nest: only the outermost begin/end pair drives the load and
  // the teardown, so a caller can open a scope without knowing whether
  // one is already active.
  beginPrefetch(root: string): void {
    this.#prefetchDepth += 1;
    if (this.#prefetchDepth > 1) return;
    this.#prefetchRoot = normalizePath(root);
    this.#direntCache = undefined;
    this.#prefetchLoad = undefined;
  }

  endPrefetch(): void {
    if (this.#prefetchDepth === 0) return;
    this.#prefetchDepth -= 1;
    if (this.#prefetchDepth > 0) return;
    this.#prefetchRoot = undefined;
    this.#direntCache = undefined;
    this.#prefetchLoad = undefined;
  }

  // Drop the snapshot. Called from every mutating method so a write
  // inside a prefetch scope is never masked by cached listings.
  #invalidatePrefetch(): void {
    this.#direntCache = undefined;
    this.#prefetchLoad = undefined;
  }

  // True when `path` sits inside the active prefetch root.
  #withinPrefetch(path: string): boolean {
    if (this.#prefetchDepth === 0 || this.#prefetchRoot === undefined) return false;
    if (this.#prefetchRoot === "/") return true;
    return path === this.#prefetchRoot || path.startsWith(`${this.#prefetchRoot}/`);
  }

  // Build the directory -> entries map for the whole prefetched
  // subtree from one find() call. Concurrent callers share the load.
  async #ensurePrefetch(): Promise<Map<string, DirentEntry[]> | undefined> {
    const root = this.#prefetchRoot;
    if (root === undefined) return undefined;
    if (this.#direntCache !== undefined) return this.#direntCache;
    if (this.#prefetchLoad === undefined) {
      this.#prefetchLoad = (async () => {
        const found = await this.#fs.find(root);
        const cache = new Map<string, DirentEntry[]>();
        // The root itself always exists as a (possibly empty) bucket so
        // an empty directory reads as empty rather than missing.
        cache.set(root, []);
        for (const entry of found) {
          const slash = entry.path.lastIndexOf("/");
          const parent = slash <= 0 ? "/" : entry.path.slice(0, slash);
          const name = entry.path.slice(slash + 1);
          let bucket = cache.get(parent);
          if (bucket === undefined) {
            bucket = [];
            cache.set(parent, bucket);
          }
          // dofs's find reports "symlink" at runtime even though the
          // published WorkspaceFoundEntry union is narrower, so widen
          // here rather than mislabelling links as regular files.
          const type = entry.type as "file" | "dir" | "symlink";
          const isDirectory = type === "dir";
          const isSymbolicLink = type === "symlink";
          bucket.push({
            name,
            isFile: !isDirectory && !isSymbolicLink,
            isDirectory,
            isSymbolicLink,
          });
          if (isDirectory && !cache.has(entry.path)) cache.set(entry.path, []);
        }
        this.#direntCache = cache;
      })();
    }
    try {
      await this.#prefetchLoad;
    } catch {
      // A failed prefetch must not fail the command: fall back to
      // direct listings for the rest of the scope.
      this.#prefetchLoad = undefined;
      return undefined;
    }
    return this.#direntCache;
  }

  // --- Reads -------------------------------------------------------

  async readFile(path: string, _options?: AdapterReadFileOptions): Promise<string> {
    if (isDevNull(path)) return "";
    // just-bash's readFile is text-by-default. The stub mirrors
    // that with the "utf8" overload; we always reach for it here.
    return this.#fs.readFile(path, "utf8");
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    if (isDevNull(path)) return new Uint8Array(0);
    const stream = await this.#fs.readFile(path);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async exists(path: string): Promise<boolean> {
    if (isVirtualDevPath(path)) return true;
    // Resolve expected misses on the host side. Throwing ENOENT across Workers
    // RPC makes workerd report an uncaught exception even when just-bash is
    // deliberately probing PATH and catches the rejection.
    return this.#fs.exists(path);
  }

  async stat(path: string): Promise<FsStat> {
    const virtual = virtualDevStat(path);
    if (virtual !== undefined) return virtual;
    const stat = await this.#fs.statOrNull(path);
    if (stat === null) throw missingPath(path);
    return mapStat(stat);
  }

  async lstat(path: string): Promise<FsStat> {
    const virtual = virtualDevStat(path);
    if (virtual !== undefined) return virtual;
    const stat = await this.#fs.lstatOrNull(path);
    if (stat === null) throw missingPath(path);
    return mapStat(stat);
  }

  async readdir(path: string): Promise<string[]> {
    if (isDevDir(path)) return ["null"];
    const entries = await this.#fs.readdir(path);
    return entries.map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    if (isDevDir(path)) {
      return [{ name: "null", isFile: true, isDirectory: false, isSymbolicLink: false }];
    }
    const normalized = normalizePath(path);
    if (this.#withinPrefetch(normalized)) {
      const cache = await this.#ensurePrefetch();
      const hit = cache?.get(normalized);
      if (hit !== undefined) return hit.map((entry) => ({ ...entry }));
      if (cache !== undefined) {
        // Inside the prefetched subtree but absent from the snapshot:
        // the directory does not exist. Surface the same error a direct
        // listing would.
        throw createWorkspaceError("ENOENT", "no such file or directory", path);
      }
    }
    const entries = await this.#fs.readdir(path);
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile,
      isDirectory: e.isDirectory,
      isSymbolicLink: e.isSymbolicLink ?? false,
    }));
  }

  async readlink(path: string): Promise<string> {
    if (isVirtualDevPath(path)) {
      throw createWorkspaceError("EINVAL", "not a symbolic link", path);
    }
    return this.#fs.readlink(path);
  }

  // --- Writes ------------------------------------------------------

  async writeFile(path: string, content: string | Uint8Array, _options?: unknown): Promise<void> {
    if (isDevNull(path)) return;
    this.#invalidatePrefetch();
    await this.#fs.writeFile(path, content);
  }

  async appendFile(path: string, content: string | Uint8Array, _options?: unknown): Promise<void> {
    if (isDevNull(path)) return;
    this.#invalidatePrefetch();
    let existing: Uint8Array;
    try {
      const stream = await this.#fs.readFile(path);
      existing = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
      existing = new Uint8Array(0);
    }
    const addition = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const out = new Uint8Array(existing.byteLength + addition.byteLength);
    out.set(existing, 0);
    out.set(addition, existing.byteLength);
    await this.#fs.writeFile(path, out);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (isDevDir(path)) return;
    this.#invalidatePrefetch();
    await this.#fs.mkdir(path, options);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    if (isVirtualDevPath(path)) return;
    this.#invalidatePrefetch();
    await this.#fs.rm(path, options);
  }

  async chmod(path: string, mode: number): Promise<void> {
    if (isVirtualDevPath(path)) return;
    this.#invalidatePrefetch();
    await this.#fs.chmod(path, mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    if (isVirtualDevPath(linkPath)) {
      throw createWorkspaceError("EEXIST", "file exists", linkPath);
    }
    this.#invalidatePrefetch();
    await this.#fs.symlink(target, linkPath);
  }

  // --- Composites --------------------------------------------------

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    this.#invalidatePrefetch();
    const recursive = options?.recursive === true;
    const s = await this.#fs.stat(src);
    if (s.isDirectory) {
      if (!recursive) {
        throw createWorkspaceError("EISDIR", `cp: source is a directory: ${src}`, src);
      }
      await this.#fs.mkdir(dest, { recursive: true });
      const entries = await this.#fs.readdir(src);
      for (const entry of entries) {
        await this.cp(joinPath(src, entry.name), joinPath(dest, entry.name), options);
      }
      return;
    }
    const bytes = await this.readFileBuffer(src);
    await this.#fs.writeFile(dest, bytes);
  }

  async mv(src: string, dest: string): Promise<void> {
    // The store doesn't have a native rename today, so model mv as
    // copy+delete. POSIX mv is atomic when src and dest live on
    // the same filesystem; this approach isn't, but it matches
    // what just-bash's other adapters do.
    await this.cp(src, dest, { recursive: true });
    await this.#fs.rm(src, { recursive: true });
  }

  // --- Pure utilities ----------------------------------------------

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    return normalizePath(`${base}/${path}`);
  }

  getAllPaths(): string[] {
    // Documented as best-effort. just-bash uses this only for glob
    // matching against in-memory roots that the adapter doesn't
    // know about. Include virtual device paths so globs can see
    // the small POSIX compatibility shim this adapter provides.
    return ["/dev", "/dev/null"];
  }

  // --- Known gaps --------------------------------------------------

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw createWorkspaceError("ENOSYS", "hard links are not supported by the workspace store");
  }

  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
    // No atime column in the store, and chmod-without-mode-change
    // is the only way to bump mtime today. Make this a no-op so
    // scripts that touch utimes don't blow up.
  }

  async realpath(path: string): Promise<string> {
    // The store's resolver already follows symlinks. realpath is
    // "the path you'd land on if you walked symlinks all the way
    // through" — for a non-symlink the answer is the canonical
    // path; for a symlink the answer is the readlink target
    // resolved relative to its parent. Stat the path first so a
    // missing entry surfaces ENOENT.
    await this.#fs.stat(path);
    return normalizePath(path);
  }
}

function missingPath(path: string): Error & { code: string; path: string } {
  const error = new Error(`ENOENT: no such file or directory, stat '${path}'`) as Error & {
    code: string;
    path: string;
  };
  error.code = "ENOENT";
  error.path = path;
  return error;
}

function mapStat(s: WorkspaceStatResult): FsStat {
  return {
    isFile: s.isFile,
    isDirectory: s.isDirectory,
    isSymbolicLink: s.isSymbolicLink,
    mode: s.mode,
    size: s.size,
    mtime: new Date(s.mtime),
  };
}

function isDevDir(path: string): boolean {
  return normalizePath(path) === "/dev";
}

function isDevNull(path: string): boolean {
  return normalizePath(path) === "/dev/null";
}

function isVirtualDevPath(path: string): boolean {
  return isDevDir(path) || isDevNull(path);
}

function virtualDevStat(path: string): FsStat | undefined {
  if (isDevDir(path)) {
    return {
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      mode: 0o755,
      size: 0,
      mtime: new Date(0),
    };
  }
  if (isDevNull(path)) {
    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o666,
      size: 0,
      mtime: new Date(0),
    };
  }
  return undefined;
}

function joinPath(a: string, b: string): string {
  if (a.endsWith("/")) return a + b;
  return `${a}/${b}`;
}

function normalizePath(path: string): string {
  const parts = path.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `/${stack.join("/")}`;
}

function createWorkspaceError(
  code: string,
  message: string,
  path?: string,
): Error & {
  code: string;
  path?: string;
} {
  const error = new Error(path === undefined ? message : `${message}: ${path}`) as Error & {
    code: string;
    path?: string;
  };
  error.name = "WorkspaceFsError";
  error.code = code;
  if (path !== undefined) error.path = path;
  return error;
}
