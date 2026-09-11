// WorkspaceFsAdapter — implements just-bash's IFileSystem against
// a WorkspaceFilesystemStub.
//
// The adapter is a thin façade. Operations that map one-for-one
// (writeFile, readdir, mkdir, rm, chmod, symlink, readlink, stat,
// lstat, rename) forward directly. Operations the stub doesn't
// expose — appendFile, cp — synthesize from the available
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
  rename(oldPath: string, newPath: string): Promise<void>;
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

  constructor(fs: WorkspaceFs) {
    this.#fs = fs;
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
    await this.#fs.writeFile(path, content);
  }

  async appendFile(path: string, content: string | Uint8Array, _options?: unknown): Promise<void> {
    if (isDevNull(path)) return;
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
    await this.#fs.mkdir(path, options);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    if (isVirtualDevPath(path)) return;
    await this.#fs.rm(path, options);
  }

  async chmod(path: string, mode: number): Promise<void> {
    if (isVirtualDevPath(path)) return;
    await this.#fs.chmod(path, mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    if (isVirtualDevPath(linkPath)) {
      throw createWorkspaceError("EEXIST", "file exists", linkPath);
    }
    await this.#fs.symlink(target, linkPath);
  }

  // --- Composites --------------------------------------------------

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
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
    // The store renames in one transaction, so an interrupted move can
    // no longer leave the bytes at both paths or a directory half
    // copied. A destination that rename refuses to replace — a
    // non-empty directory, or a directory and a non-directory in
    // either order — still falls back to copy-then-delete, which is
    // what the shell's own `mv` expects when it merges a tree.
    try {
      await this.#fs.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "ENOTEMPTY" && code !== "EISDIR" && code !== "ENOTDIR") throw err;
    }
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
