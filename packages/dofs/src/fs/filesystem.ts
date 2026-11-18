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
//
// Reads go through passthrough.ts, which sends a path under a
// passthrough mount to its mount and every other path to the free
// function. Writes need no routing: the mount guard the free
// functions run rejects them under a passthrough root.

import type { Database } from "../storage";

import { chmod } from "./chmod";
import type { FindOptions, WorkspaceFoundEntry } from "./find";
import type { GrepOptions, WorkspaceGrepMatch } from "./grep";
import { type MkdirOptions, mkdir } from "./mkdir";
import {
  chmodInMount,
  findWithPassthrough,
  grepWithPassthrough,
  lsWithPassthrough,
  mkdirInMount,
  readdirWithPassthrough,
  readFileWithPassthrough,
  readlinkWithPassthrough,
  renameWithMount,
  rmInMount,
  statWithPassthrough,
  unsupportedWrite,
  writeFileToMount,
  writeTarget,
} from "./passthrough";
import { asReadOnly } from "./passthrough-registry";
import type { ReaddirOptions, WorkspaceDirentResult } from "./readdir";
import type { ReadFileOptions } from "./readFile";
import { rename } from "./rename";
import { type RmOptions, rm } from "./rm";
import type { WorkspaceStatResult } from "./stat";
import { symlink } from "./symlink";
import { type WriteFileContent, type WriteFileOptions, writeFile } from "./writeFile";

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
    return readFileWithPassthrough(this.db, path, optionsOrEncoding);
  }

  // The async reads below `return await` for the reason given above the
  // entry points in passthrough.ts: a returned rejected promise is
  // reported as unhandled by workerd before the caller sees it.
  async stat(path: string): Promise<WorkspaceStatResult> {
    return await statWithPassthrough(this.db, path, true);
  }

  // POSIX lstat — like stat, but doesn't follow a trailing symlink.
  // Use when the caller wants to inspect the link itself: readlink
  // / unlink under a Node-style fs surface, or just-bash's adapter
  // routing lstat through to the workspace.
  async lstat(path: string): Promise<WorkspaceStatResult> {
    return await statWithPassthrough(this.db, path, false);
  }

  // Return the stored target of a symlink. EINVAL when path is
  // not a symlink; ENOENT when path is missing.
  async readlink(path: string): Promise<string> {
    return await readlinkWithPassthrough(this.db, path);
  }

  async readdir(path: string, options: ReaddirOptions = {}): Promise<WorkspaceDirentResult[]> {
    return await readdirWithPassthrough(this.db, path, options);
  }

  async find(
    directory: string,
    pattern?: string,
    options: FindOptions = {},
  ): Promise<WorkspaceFoundEntry[]> {
    return await findWithPassthrough(this.db, directory, pattern, options);
  }

  async ls(prefix: string): Promise<string[]> {
    return await lsWithPassthrough(this.db, prefix);
  }

  grep(pattern: string, path: string, options: GrepOptions = {}): Promise<WorkspaceGrepMatch[]> {
    return grepWithPassthrough(this.db, pattern, path, options);
  }

  // --- Mutations ---------------------------------------------------
  //
  // A write that lands under a read-write passthrough root, by name or
  // through a symbolic link, goes to the mount before any SQL; under a
  // read-only one it fails with EROFS, as the free functions' guard
  // makes every write there fail.

  async writeFile(
    path: string,
    content: WriteFileContent,
    options: WriteFileOptions = {},
  ): Promise<void> {
    const target = writeTarget(this.db, path, true);
    if (target !== undefined) return writeFileToMount(target, content, options);
    try {
      await writeFile(this.db, path, content, options, this.now);
    } catch (error) {
      throw asReadOnly(error);
    }
  }

  async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    const target = writeTarget(this.db, path, false);
    if (target !== undefined) return mkdirInMount(target, options);
    try {
      mkdir(this.db, path, options, this.now);
    } catch (error) {
      throw asReadOnly(error);
    }
  }

  async rm(path: string, options: RmOptions = {}): Promise<void> {
    const target = writeTarget(this.db, path, false);
    if (target !== undefined) return rmInMount(target, options);
    try {
      rm(this.db, path, options);
    } catch (error) {
      throw asReadOnly(error);
    }
  }

  // Move a file, directory or symbolic link in one transaction. An
  // existing destination is replaced when the two ends agree on kind:
  // a file or symbolic link replaces a file or symbolic link, and a
  // directory replaces an empty directory.
  //
  // Errors: ENOENT when the source is missing or the destination's
  // parent does not exist, ENOTEMPTY when the destination is a
  // non-empty directory, EISDIR when a non-directory would replace a
  // directory, ENOTDIR when a directory would replace a
  // non-directory, EINVAL for the root at either end or a directory
  // moved into itself, EROFS under a read-only mount, and EXDEV
  // between the store and a passthrough mount or two of them.
  async rename(oldPath: string, newPath: string): Promise<void> {
    const from = writeTarget(this.db, oldPath, false);
    const to = writeTarget(this.db, newPath, false);
    if (from !== undefined || to !== undefined) {
      return renameWithMount(from, to, oldPath, newPath);
    }
    try {
      rename(this.db, oldPath, newPath);
    } catch (error) {
      throw asReadOnly(error);
    }
  }

  // Change the permission bits on a path. Follows symlinks like
  // POSIX chmod — the change lands on the target, not the link.
  // The supplied mode is masked to twelve bits.
  async chmod(path: string, mode: number): Promise<void> {
    const target = writeTarget(this.db, path, true);
    if (target !== undefined) return chmodInMount(target, mode);
    try {
      chmod(this.db, path, mode, this.now);
    } catch (error) {
      throw asReadOnly(error);
    }
  }

  // Create a symbolic link at `path` pointing at `target`. The
  // target is stored verbatim; it can be relative or absolute and
  // is allowed to dangle. A passthrough mount holds no links.
  async symlink(target: string, path: string): Promise<void> {
    const mount = writeTarget(this.db, path, false);
    if (mount !== undefined) throw unsupportedWrite(mount);
    try {
      symlink(this.db, target, path, this.now);
    } catch (error) {
      throw asReadOnly(error);
    }
  }
}
