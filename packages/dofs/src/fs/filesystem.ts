// WorkspaceFilesystem — class wrapper that binds a Database and a
// clock to the free fs/* functions.
//
// Every method here is a thin forward to the matching free
// function. The class exists so callers (host-side Workspace,
// in-container tools, tests) get a single instance to thread
// through their code rather than passing (db, now) pairs into
// every call.
//
// Free functions remain exported for internal callers — the
// apply paths in sync/* operate on a Database directly, and the
// in-package tests skip the class wrapper when they only need a
// single op.

import type { Database } from "../storage.js";

import { chmod } from "./chmod.js";
import { find, type WorkspaceFoundEntry } from "./find.js";
import { type GrepOptions, grep, type WorkspaceGrepMatch } from "./grep.js";
import { ls } from "./ls.js";
import { type MkdirOptions, mkdir } from "./mkdir.js";
import { type ReaddirOptions, readdir, type WorkspaceDirentResult } from "./readdir.js";
import { type ReadFileOptions, readFile, readRangeSync } from "./readFile.js";
import { readlink } from "./readlink.js";
import { type RmOptions, rm } from "./rm.js";
import { lstat, stat, type WorkspaceStatResult } from "./stat.js";
import { symlink } from "./symlink.js";
import { type WriteFileContent, type WriteFileOptions, writeFile } from "./writeFile.js";

export interface WorkspaceFilesystemOptions {
  // Clock used for mtime / last_seen. Defaults to Date.now.
  // Override for deterministic tests.
  now?: () => number;
}

export class WorkspaceFilesystem {
  readonly db: Database;
  readonly now: () => number;

  constructor(db: Database, options: WorkspaceFilesystemOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
  }

  // --- Reads -------------------------------------------------------

  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(
    path: string,
    options: ReadFileOptions & { encoding?: undefined },
  ): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, options: ReadFileOptions & { encoding: "utf8" }): Promise<string>;
  readFile(path: string, options: ReadFileOptions): Promise<string | ReadableStream<Uint8Array>>;
  readFile(
    path: string,
    optionsOrEncoding?: "utf8" | ReadFileOptions,
  ): Promise<string | ReadableStream<Uint8Array>> {
    // Forward through the free function's overload set. The
    // individual overloads above let callers see the precise
    // return type for each input shape.
    // Cast through the union overload of the free function;
    // the class's overloads above carry the precise return type
    // for each input shape back to the caller.
    return readFile(this.db, path, optionsOrEncoding as ReadFileOptions);
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    return readRangeSync(this.db, path, offset, length).slice();
  }

  async stat(path: string): Promise<WorkspaceStatResult> {
    return stat(this.db, path);
  }

  // POSIX lstat — like stat, but doesn't follow a trailing symlink.
  // Use when the caller wants to inspect the link itself: readlink
  // / unlink under a Node-style fs surface, or just-bash's adapter
  // routing lstat through to the workspace.
  async lstat(path: string): Promise<WorkspaceStatResult> {
    return lstat(this.db, path);
  }

  // Return the stored target of a symlink. EINVAL when path is
  // not a symlink; ENOENT when path is missing.
  async readlink(path: string): Promise<string> {
    return readlink(this.db, path);
  }

  async readdir(path: string, options: ReaddirOptions = {}): Promise<WorkspaceDirentResult[]> {
    return readdir(this.db, path, options);
  }

  async find(directory: string, pattern?: string): Promise<WorkspaceFoundEntry[]> {
    return find(this.db, directory, pattern);
  }

  async ls(prefix: string): Promise<string[]> {
    return ls(this.db, prefix);
  }

  grep(pattern: string, path: string, options: GrepOptions = {}): Promise<WorkspaceGrepMatch[]> {
    return grep(this.db, pattern, path, options);
  }

  // --- Mutations ---------------------------------------------------

  writeFile(
    path: string,
    content: WriteFileContent,
    options: WriteFileOptions = {},
  ): Promise<void> {
    return writeFile(this.db, path, content, options, this.now);
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    mkdir(this.db, path, options, this.now);
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    rm(this.db, path, options);
  }

  // Change the permission bits on a path. Follows symlinks like
  // POSIX chmod — the change lands on the target, not the link.
  // The supplied mode is masked to twelve bits.
  async chmod(path: string, mode: number): Promise<void> {
    chmod(this.db, path, mode, this.now);
  }

  // Create a symbolic link at `path` pointing at `target`. The
  // target is stored verbatim; it can be relative or absolute and
  // is allowed to dangle.
  async symlink(target: string, path: string): Promise<void> {
    symlink(this.db, target, path, this.now);
  }
}
