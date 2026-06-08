// SQLiteWorkspaceProvider — a @platformatic/vfs VirtualProvider backed
// by the dofs SQLite store.
//
// Every method on VirtualProvider is declared. Methods we already have
// synchronous building blocks for delegate to the existing fs/ helpers;
// the rest throw ENOSYS so the gaps are visible at the call site.
// Subsequent commits fill in the stubs (file descriptors, positional
// I/O, truncate, symlinks, watch).

import { createWorkspaceError } from "./errors.js";
import { link as linkImpl } from "./fs/link.js";
import type { MkdirOptions } from "./fs/mkdir.js";
import { mkdir as mkdirImpl } from "./fs/mkdir.js";
import { readdir as readdirImpl } from "./fs/readdir.js";
import { readlink as readlinkImpl } from "./fs/readlink.js";
import { resolveInode } from "./fs/resolve.js";
import { rm as rmImpl } from "./fs/rm.js";
import { stat as statImpl } from "./fs/stat.js";
import { symlink as symlinkImpl } from "./fs/symlink.js";
import {
  createWatchAsyncIterable,
  createWatcher,
  type WatchEvent,
  type WatchHandle,
  type WatchOptions,
} from "./fs/watch.js";
import {
  createFileSync as createFileSyncImpl,
  truncateFileSync as truncateFileSyncImpl,
  type WriteFileRange,
  writeFileRangesSync as writeFileRangesSyncImpl,
  writeFileSync as writeFileSyncImpl,
  writeRangeSync as writeRangeSyncImpl,
} from "./fs/writeFile.js";
import { canonicalizePath } from "./path.js";
import type { Database } from "./storage.js";

export interface SQLiteWorkspaceProviderOptions {
  // Wall-clock source. Defaults to Date.now so production callers
  // don't need to thread one through; tests pin it.
  now?: () => number;
  // Poll interval for watch() in milliseconds. Defaults to 100 ms
  // to match node's fs.watch on most filesystems; tests can lower
  // it to keep durations short.
  watchIntervalMs?: number;
}

interface VirtualStatsLike {
  dev: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  blksize: number;
  ino: number;
  size: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

interface VirtualDirentLike {
  name: string;
  parentPath: string;
  path: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

interface FdState {
  path: string;
  position: number;
  readable: boolean;
  writable: boolean;
  // append mode pins every writeSync to current EOF rather than
  // honouring an explicit position argument.
  append: boolean;
}

export class SQLiteWorkspaceProvider {
  readonly db: Database;
  readonly now: () => number;

  // Capability flags consulted by @platformatic/vfs callers.
  readonly readonly = false;
  readonly supportsSymlinks = true;
  readonly supportsWatch = true;

  // Fd table. Start at 3 — 0/1/2 are reserved by convention even
  // though we don't expose them — so consumers that pass them around
  // can't accidentally collide with stdio mental models.
  #fds = new Map<number, FdState>();
  #nextFd = 3;

  readonly watchIntervalMs: number;

  constructor(db: Database, options: SQLiteWorkspaceProviderOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.watchIntervalMs = options.watchIntervalMs ?? 100;
  }

  // -- Essential primitives ------------------------------------------

  open(path: string, flags?: string, mode?: number): Promise<number> {
    return Promise.resolve(this.openSync(path, flags, mode));
  }

  openSync(path: string, flags: string = "r", _mode?: number): number {
    const { read, write, truncate, append, create, exclusive } = parseFlags(flags);
    const existing = resolveInode(this.db, path);

    if (existing === null) {
      if (!create) {
        throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
      }
      writeFileSyncImpl(this.db, path, new Uint8Array(), {}, this.now);
    } else {
      if (existing.type !== "file") {
        throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
      }
      if (exclusive) {
        throw createWorkspaceError("EEXIST", `path exists: ${path}`, path);
      }
      if (truncate) {
        writeFileSyncImpl(this.db, path, new Uint8Array(), {}, this.now);
      }
    }

    const stat = statImpl(this.db, path);
    const fd = this.#nextFd++;
    this.#fds.set(fd, {
      path,
      position: append ? stat.size : 0,
      readable: read,
      writable: write,
      append,
    });
    return fd;
  }

  stat(path: string, options?: { bigint?: boolean }): Promise<VirtualStatsLike> {
    return Promise.resolve(this.statSync(path, options));
  }

  statSync(path: string, _options?: { bigint?: boolean }): VirtualStatsLike {
    const s = statImpl(this.db, path);
    const node = resolveInode(this.db, path);
    const ino = node?.inode ?? 0;
    return wrapStats({
      mode: s.mode,
      size: s.size,
      mtimeMs: s.mtime,
      ino,
      isFile: s.isFile,
      isDirectory: s.isDirectory,
      isSymbolicLink: false,
      nlink: linkCount(this.db, ino),
    });
  }

  lstat(path: string, options?: { bigint?: boolean }): Promise<VirtualStatsLike> {
    return Promise.resolve(this.lstatSync(path, options));
  }

  lstatSync(path: string, _options?: { bigint?: boolean }): VirtualStatsLike {
    const node = resolveInode(this.db, path, { followSymlinks: false });
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
    }
    const isSymlink = node.type === "symlink";
    const size = isSymlink
      ? (node.linkTarget ?? "").length
      : node.type === "file"
        ? fileSize(this.db, node.inode)
        : 0;
    return wrapStats({
      mode: node.mode,
      size,
      mtimeMs: node.mtime,
      ino: node.inode,
      isFile: node.type === "file",
      isDirectory: node.type === "dir",
      isSymbolicLink: isSymlink,
      nlink: linkCount(this.db, node.inode),
    });
  }

  readdir(
    path: string,
    options?: { withFileTypes?: boolean },
  ): Promise<string[] | VirtualDirentLike[]> {
    return Promise.resolve(this.readdirSync(path, options));
  }

  readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | VirtualDirentLike[] {
    const entries = readdirImpl(this.db, path);
    if (options?.withFileTypes === true) {
      return entries.map((entry) => wrapDirent(entry));
    }
    return entries.map((entry) => entry.name);
  }

  mkdir(path: string, options?: MkdirOptions): Promise<string | undefined> {
    return Promise.resolve(this.mkdirSync(path, options));
  }

  mkdirSync(path: string, options?: MkdirOptions): string | undefined {
    mkdirImpl(this.db, path, options ?? {}, this.now);
    return undefined;
  }

  rmdir(path: string): Promise<void> {
    this.rmdirSync(path);
    return Promise.resolve();
  }

  rmdirSync(path: string): void {
    rmImpl(this.db, path, {});
  }

  unlink(path: string): Promise<void> {
    this.unlinkSync(path);
    return Promise.resolve();
  }

  unlinkSync(path: string): void {
    rmImpl(this.db, path, {});
  }

  link(existingPath: string, newPath: string): Promise<void> {
    this.linkSync(existingPath, newPath);
    return Promise.resolve();
  }

  linkSync(existingPath: string, newPath: string): void {
    linkImpl(this.db, existingPath, newPath);
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    this.renameSync(oldPath, newPath);
    return Promise.resolve();
  }

  renameSync(oldPath: string, newPath: string): void {
    // The FS module doesn't expose rename as a standalone operation
    // yet; we lean on the existing schema-level pieces here. When
    // rename grows up (cross-directory, overwriting an existing file,
    // ...) it should move into fs/rename.ts with its own tests.
    const node = resolveInode(this.db, oldPath);
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${oldPath}`, oldPath);
    }
    const { parts: oldParts, path: oldCanonical } = canonicalizePath(oldPath);
    const oldName = oldParts[oldParts.length - 1];
    const oldParentPath = oldParts.length === 1 ? "/" : `/${oldParts.slice(0, -1).join("/")}`;
    const oldParent = resolveInode(this.db, oldParentPath, { followSymlinks: false });
    if (oldParent === null || oldParent.type !== "dir") {
      throw createWorkspaceError(
        "ENOENT",
        `parent directory missing: ${oldCanonical}`,
        oldCanonical,
      );
    }
    const { parts, path: newCanonical } = canonicalizePath(newPath);
    if (oldCanonical === newCanonical) return;
    if (parts.length === 0) {
      throw createWorkspaceError("EINVAL", "cannot rename onto root", newCanonical);
    }
    const newName = parts[parts.length - 1];
    const newParentPath = parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
    const newParent = resolveInode(this.db, newParentPath);
    if (newParent === null || newParent.type !== "dir") {
      throw createWorkspaceError(
        "ENOENT",
        `parent directory missing: ${newCanonical}`,
        newCanonical,
      );
    }
    this.db.transactionSync(() => {
      // If the destination already exists, displace it before linking
      // the source dirent. POSIX rename(2) is atomic and overwrites a
      // regular file or empty directory at the target. We follow the
      // same semantics: an existing file at newPath is unlinked, and
      // its inode (and chunks / blobs) are reaped via the existing
      // gc() safety window.
      const existing = this.db.one<{ child_inode: number; type: string }>(
        `SELECT d.child_inode AS child_inode, n.type AS type
         FROM vfs_dirents d JOIN vfs_nodes n ON n.inode = d.child_inode
         WHERE d.parent_inode = ? AND d.name = ?`,
        newParent.inode,
        newName,
      );
      const destinationAlreadyNamesSource = existing?.child_inode === node.inode;
      if (existing !== undefined && !destinationAlreadyNamesSource) {
        // Refuse to overwrite a non-empty directory or replace a
        // directory with a file (Linux rename semantics).
        if (existing.type === "dir") {
          const childCount = this.db.scalar<number>(
            "SELECT COUNT(*) FROM vfs_dirents WHERE parent_inode = ?",
            existing.child_inode,
          );
          if ((childCount ?? 0) > 0) {
            throw createWorkspaceError("ENOTEMPTY", `not empty: ${newCanonical}`, newCanonical);
          }
        }
        // Unlink only the displaced destination name. If other
        // hardlinks still reference the displaced file inode, keep its
        // chunks and node alive.
        this.db.run(
          "DELETE FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
          newParent.inode,
          newName,
        );
        const remaining = this.db.scalar<number>(
          "SELECT COUNT(*) FROM vfs_dirents WHERE child_inode = ?",
          existing.child_inode,
        );
        if ((remaining ?? 0) === 0) {
          this.db.run("DELETE FROM vfs_chunks WHERE inode = ?", existing.child_inode);
          this.db.run("DELETE FROM vfs_nodes WHERE inode = ?", existing.child_inode);
        }
      }
      this.db.run(
        "DELETE FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
        oldParent.inode,
        oldName,
      );
      if (!destinationAlreadyNamesSource) {
        this.db.run(
          "INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)",
          newParent.inode,
          newName,
          node.inode,
        );
      }
    });
  }

  // -- Default implementations ---------------------------------------

  readFile(
    path: string,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
  ): Promise<Buffer | string> {
    return Promise.resolve(this.readFileSync(path, options));
  }

  readFileSync(
    path: string,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
  ): Buffer | string {
    const node = resolveInode(this.db, path);
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
    }
    if (node.type !== "file") {
      throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
    }
    const inline = this.db.one<{ inline_data: Uint8Array | null }>(
      "SELECT inline_data FROM vfs_nodes WHERE inode = ?",
      node.inode,
    )?.inline_data;
    const encoding = typeof options === "string" ? options : options?.encoding;
    if (inline !== undefined && inline !== null) {
      const out = Buffer.from(inline);
      return encoding ? out.toString(encoding) : out;
    }

    const chunks = this.db.all<{ hash: Uint8Array; size: number }>(
      "SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
      node.inode,
    );
    let total = 0;
    for (const c of chunks) total += c.size;
    const out = Buffer.alloc(total);
    let offset = 0;
    for (const chunk of chunks) {
      const row = this.db.one<{ bytes: Uint8Array }>(
        "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
        chunk.hash,
      );
      if (row === undefined) {
        throw createWorkspaceError("EIO", `missing blob bytes for ${path}`, path);
      }
      out.set(row.bytes, offset);
      offset += row.bytes.byteLength;
    }
    return encoding ? out.toString(encoding) : out;
  }

  writeFile(
    path: string,
    data: string | Buffer,
    options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): Promise<void> {
    this.writeFileSync(path, data, options);
    return Promise.resolve();
  }

  writeFileSync(
    path: string,
    data: string | Buffer,
    options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): void {
    const mode = typeof options === "string" ? undefined : options?.mode;
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    writeFileSyncImpl(this.db, path, bytes, { mode }, this.now);
  }

  writeFileRangesSync(
    path: string,
    data: string | Buffer,
    ranges: WriteFileRange[],
    options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): void {
    const mode = typeof options === "string" ? undefined : options?.mode;
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    writeFileRangesSyncImpl(this.db, path, bytes, ranges, { mode }, this.now);
  }

  createFileSync(path: string, options?: { mode?: number }): void {
    createFileSyncImpl(this.db, path, { mode: options?.mode }, this.now);
  }

  writeRangeSync(
    path: string,
    data: string | Buffer | Uint8Array,
    offset: number,
    options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): number {
    const mode = typeof options === "string" ? undefined : options?.mode;
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return writeRangeSyncImpl(this.db, path, bytes, offset, { mode }, this.now);
  }

  truncateFileSync(path: string, len: number): void {
    truncateFileSyncImpl(this.db, path, len, this.now);
  }

  appendFile(
    _path: string,
    _data: string | Buffer,
    _options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): Promise<void> {
    return Promise.reject(notImplemented("appendFile"));
  }

  appendFileSync(
    _path: string,
    _data: string | Buffer,
    _options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): void {
    throw notImplemented("appendFileSync");
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.existsSync(path));
  }

  existsSync(path: string): boolean {
    try {
      return resolveInode(this.db, path) !== null;
    } catch {
      return false;
    }
  }

  copyFile(_src: string, _dest: string, _mode?: number): Promise<void> {
    return Promise.reject(notImplemented("copyFile"));
  }

  copyFileSync(_src: string, _dest: string, _mode?: number): void {
    throw notImplemented("copyFileSync");
  }

  internalModuleStat(_path: string): number {
    // Used by node:vfs module-resolution hooks. The wsd driver doesn't
    // need it; if this provider is ever mounted via `vfs.mount()` we'll
    // need to return 0 for files, 1 for dirs, -1 for not-found.
    throw notImplemented("internalModuleStat");
  }

  realpath(path: string, _options?: { encoding?: BufferEncoding }): Promise<string> {
    return Promise.resolve(this.realpathSync(path));
  }

  realpathSync(path: string, _options?: { encoding?: BufferEncoding }): string {
    const { path: canonical } = canonicalizePath(path);
    if (resolveInode(this.db, canonical) === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }
    return canonical;
  }

  access(path: string, _mode?: number): Promise<void> {
    this.accessSync(path);
    return Promise.resolve();
  }

  accessSync(path: string, _mode?: number): void {
    if (resolveInode(this.db, path) === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
    }
  }

  // -- File descriptors ----------------------------------------------

  closeSync(fd: number): void {
    if (!this.#fds.delete(fd)) {
      throw createWorkspaceError("EBADF", `unknown fd ${fd}`);
    }
  }

  readSync(
    fd: number,
    buffer: Buffer | Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number {
    const state = this.#fdOrThrow(fd);
    if (!state.readable) {
      throw createWorkspaceError("EBADF", `fd ${fd} is not readable`);
    }
    const startAt = position ?? state.position;
    const bytes = readFileBytesSync(this.db, state.path);
    if (startAt >= bytes.byteLength) {
      return 0;
    }
    const end = Math.min(startAt + length, bytes.byteLength);
    const n = end - startAt;
    const view =
      buffer instanceof Buffer
        ? buffer
        : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    view.set(bytes.subarray(startAt, end), offset);
    if (position === null || position === undefined) {
      state.position += n;
    }
    return n;
  }

  writeSync(
    fd: number,
    buffer: Buffer | Uint8Array,
    offset: number = 0,
    length: number = buffer.byteLength - offset,
    position: number | null = null,
  ): number {
    const state = this.#fdOrThrow(fd);
    if (!state.writable) {
      throw createWorkspaceError("EBADF", `fd ${fd} is not writable`);
    }
    const stat = this.statSync(state.path);
    const startAt = state.append ? stat.size : (position ?? state.position);
    const view =
      buffer instanceof Buffer
        ? new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length)
        : new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
    writeRangeSyncImpl(this.db, state.path, view, startAt, {}, this.now);
    if (position === null || position === undefined) {
      state.position = startAt + length;
    }
    return length;
  }

  fstatSync(fd: number, _options?: { bigint?: boolean }): VirtualStatsLike {
    const state = this.#fdOrThrow(fd);
    return this.statSync(state.path);
  }

  truncateSync(path: string, len: number): void {
    const node = resolveInode(this.db, path);
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
    }
    if (node.type !== "file") {
      throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
    }
    truncateFileSyncImpl(this.db, path, len, this.now);
  }

  ftruncateSync(fd: number, len: number): void {
    const state = this.#fdOrThrow(fd);
    this.truncateSync(state.path, len);
  }

  #fdOrThrow(fd: number): FdState {
    const state = this.#fds.get(fd);
    if (state === undefined) {
      throw createWorkspaceError("EBADF", `unknown fd ${fd}`);
    }
    return state;
  }

  // -- Symlinks ------------------------------------------------------

  readlink(path: string, _options?: { encoding?: BufferEncoding }): Promise<string> {
    return Promise.resolve(this.readlinkSync(path));
  }

  readlinkSync(path: string, _options?: { encoding?: BufferEncoding }): string {
    return readlinkImpl(this.db, path);
  }

  symlink(target: string, path: string, _type?: string): Promise<void> {
    this.symlinkSync(target, path);
    return Promise.resolve();
  }

  symlinkSync(target: string, path: string, _type?: string): void {
    symlinkImpl(this.db, target, path, this.now);
  }

  // -- Watch ----------------------------------------------------------
  //
  // The watcher polls vfs_meta.rev on a timer. Each tick
  // coalesceChanges yields every path touched since the last
  // observed rev; we filter by the watched directory (and
  // recursive flag) and emit one 'change' event per path. Cheap
  // because coalesceChanges is one indexed range scan on
  // vfs_nodes.rev plus a path walk per touched inode.
  //
  // Event types follow node's fs.watch convention:
  //   - 'rename' for deletes (path went away)
  //   - 'change' for everything else (file/dir/symlink mutation)
  // We don't distinguish first-time creation from in-place edit
  // — the cost is a per-watcher state map that's bigger than
  // the signal is worth. Callers that need rename-vs-change
  // semantics can stat the path themselves.

  watch(path: string, options: WatchOptions = {}): WatchHandle {
    return createWatcher(this.db, path, options, this.watchIntervalMs);
  }

  watchAsync(path: string, options: WatchOptions = {}): AsyncIterable<WatchEvent> {
    return createWatchAsyncIterable(this.watch(path, options));
  }

  // watchFile / unwatchFile fire on stat changes at a single path
  // (not the directory under it). Different semantics from watch();
  // editors typically use watch() instead. Leave as ENOSYS until a
  // real call site shows up.
  watchFile(
    _path: string,
    _options?: unknown,
    _listener?: (curr: VirtualStatsLike, prev: VirtualStatsLike) => void,
  ): unknown {
    throw notImplemented("watchFile");
  }

  unwatchFile(
    _path: string,
    _listener?: (curr: VirtualStatsLike, prev: VirtualStatsLike) => void,
  ): void {
    throw notImplemented("unwatchFile");
  }
}

function notImplemented(method: string) {
  return createWorkspaceError("ENOSYS", `SQLiteWorkspaceProvider.${method} is not implemented yet`);
}

// -- VirtualStats / VirtualDirent shim ------------------------------
//
// @platformatic/vfs callers (and FUSE drivers built on top) consult
// the full Node-style stat shape. Most fields don't map onto our
// content-addressed store, so they get sensible constants. The fields
// that do map — mode, size, mtime, ino — are populated for real.

interface StatsInputs {
  mode: number;
  size: number;
  mtimeMs: number;
  ino: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  nlink: number;
}

// POSIX mode-bit constants. Linux FUSE rejects a stat whose mode
// has no S_IF* bits set with EIO — it can't decide whether
// the inode is a regular file, a directory, or a symlink.
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function fileTypeBits(input: StatsInputs): number {
  if (input.isDirectory) return S_IFDIR;
  if (input.isSymbolicLink) return S_IFLNK;
  if (input.isFile) return S_IFREG;
  return 0;
}

function linkCount(db: Database, inode: number): number {
  const count = db.scalar<number>("SELECT COUNT(*) FROM vfs_dirents WHERE child_inode = ?", inode);
  return Math.max(1, count ?? 0);
}

function fileSize(db: Database, inode: number): number {
  const inlineSize = db.one<{ size: number | null }>(
    "SELECT length(inline_data) AS size FROM vfs_nodes WHERE inode = ?",
    inode,
  )?.size;
  return (
    inlineSize ??
    db.scalar<number>("SELECT COALESCE(SUM(size), 0) FROM vfs_chunks WHERE inode = ?", inode) ??
    0
  );
}

function wrapStats(input: StatsInputs): VirtualStatsLike {
  const mtime = new Date(input.mtimeMs);
  return {
    dev: 0,
    mode: (input.mode & 0o7777) | fileTypeBits(input),
    nlink: input.nlink,
    uid: 0,
    gid: 0,
    rdev: 0,
    blksize: 4096,
    ino: input.ino,
    size: input.size,
    blocks: Math.ceil(input.size / 512),
    atimeMs: input.mtimeMs,
    mtimeMs: input.mtimeMs,
    ctimeMs: input.mtimeMs,
    birthtimeMs: input.mtimeMs,
    atime: mtime,
    mtime,
    ctime: mtime,
    birthtime: mtime,
    isFile: () => input.isFile,
    isDirectory: () => input.isDirectory,
    isSymbolicLink: () => input.isSymbolicLink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

interface DirentInput {
  name: string;
  parentPath: string;
  isFile: boolean;
  isDirectory: boolean;
}

function wrapDirent(input: DirentInput): VirtualDirentLike {
  const fullPath =
    input.parentPath === "/" ? `/${input.name}` : `${input.parentPath}/${input.name}`;
  return {
    name: input.name,
    parentPath: input.parentPath,
    path: fullPath,
    isFile: () => input.isFile,
    isDirectory: () => input.isDirectory,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

interface ParsedFlags {
  read: boolean;
  write: boolean;
  create: boolean;
  truncate: boolean;
  append: boolean;
  exclusive: boolean;
}

// Translate Node's fs flag strings into the boolean flag set the fd
// table uses. Mirrors the documented behaviour of fs.open(flags) at
// https://nodejs.org/api/fs.html#file-system-flags.
function parseFlags(flags: string): ParsedFlags {
  switch (flags) {
    case "r":
      return {
        read: true,
        write: false,
        create: false,
        truncate: false,
        append: false,
        exclusive: false,
      };
    case "r+":
      return {
        read: true,
        write: true,
        create: false,
        truncate: false,
        append: false,
        exclusive: false,
      };
    case "w":
      return {
        read: false,
        write: true,
        create: true,
        truncate: true,
        append: false,
        exclusive: false,
      };
    case "w+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: true,
        append: false,
        exclusive: false,
      };
    case "wx":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: false,
        exclusive: true,
      };
    case "wx+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: false,
        exclusive: true,
      };
    case "a":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: false,
      };
    case "a+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: false,
      };
    case "ax":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: true,
      };
    case "ax+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: true,
      };
    default:
      throw createWorkspaceError("EINVAL", `unsupported fs flag: ${flags}`);
  }
}

// Pull a file's full content out of the chunk store into one buffer.
// Used by the fd-positional code paths because the simplest correct
// model for writeSync/truncate is "read whole file, splice, write
// whole file"; the content-addressed write path keeps untouched
// chunks deduped so this only costs the changed chunks on the wire.
function readFileBytesSync(db: Database, path: string): Uint8Array {
  const node = resolveInode(db, path);
  if (node === null) {
    throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
  }
  if (node.type !== "file") {
    throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
  }
  const inline = db.one<{ inline_data: Uint8Array | null }>(
    "SELECT inline_data FROM vfs_nodes WHERE inode = ?",
    node.inode,
  )?.inline_data;
  if (inline !== undefined && inline !== null) return inline;

  const chunks = db.all<{ hash: Uint8Array; size: number }>(
    "SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
    node.inode,
  );
  let total = 0;
  for (const c of chunks) total += c.size;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    const row = db.one<{ bytes: Uint8Array }>(
      "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
      chunk.hash,
    );
    if (row === undefined) {
      throw createWorkspaceError("EIO", `missing blob bytes for ${path}`, path);
    }
    out.set(row.bytes, pos);
    pos += row.bytes.byteLength;
  }
  return out;
}
