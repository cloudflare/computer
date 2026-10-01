// Local-only passthrough for the FUSE op layer. See
// packages/computerd/README.md.
//
// A decorator over FuseOps rather than branches inside makeFUSEOps, so
// the VFS driver stays unaware of the feature and an empty ignore set
// is provably a no-op: `withLocalPassthrough` returns the source object
// unchanged.
//
// Despite the name there is no FUSE passthrough (FOPEN_PASSTHROUGH)
// here; fuse-native binds libfuse 2.9, below the API version that can
// negotiate it. Data still crosses the FUSE boundary into this process.
// What it skips is the VFS, the SQLite store, the change-pack encoding,
// and the pull into the Durable Object.
//
// Writes go straight to the host filesystem with pwrite rather than
// through the buffered FileEntry machinery in driver.ts. That buffering
// exists because the VFS has no ranged-write primitive and a naive
// implementation is O(N^2) over sequential appends; the kernel does not
// have that problem, so the indirection would be pure cost here.

import {
  accessSync,
  chmodSync,
  chownSync,
  closeSync,
  fdatasyncSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lchownSync,
  linkSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmdirSync,
  type Stats,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";

import type { FuseOps, FuseStat } from "./driver.js";
import type { MountIgnoreSet } from "./ignore.js";

// Mirrors driver.ts. Duplicated rather than exported across modules
// because these are the kernel's numbers, not ours, and a shared
// mutable table would be a worse coupling than two short lists.
const ERRNO = {
  EPERM: -1,
  ENOENT: -2,
  EIO: -5,
  EBADF: -9,
  EACCES: -13,
  EEXIST: -17,
  EXDEV: -18,
  ENOTDIR: -20,
  EISDIR: -21,
  EINVAL: -22,
  ENOTEMPTY: -39,
} as const;

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;

export interface LocalPassthroughOptions {
  /** Resolved MOUNT_IGNORE_PATH: where local-only paths are stored. */
  readonly root: string;
  /** The decided ignore set. An empty set disables the feature entirely. */
  readonly ignore: MountIgnoreSet;
  /** Mount point, so kernel paths can be made mount-relative. */
  readonly mountPoint?: string;
  /** Injected for tests. Defaults to the real node:fs surface. */
  readonly fs?: PassthroughFs;
  /** Called once per distinct local-only directory created. Diagnostics. */
  readonly onMaterialize?: (relativePath: string) => void;
  /** Operator-facing warnings. Defaults to console.warn; injected for tests. */
  readonly warn?: (message: string) => void;
}

/**
 * The slice of node:fs this module uses.
 *
 * Narrow on purpose: it is the seam the unit tests drive, and keeping
 * it small is what makes an in-memory double practical.
 */
export interface PassthroughFs {
  openSync: typeof openSync;
  closeSync: typeof closeSync;
  readSync: typeof readSync;
  writeSync: typeof writeSync;
  fstatSync: typeof fstatSync;
  statSync: typeof statSync;
  lstatSync: typeof lstatSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readlinkSync: typeof readlinkSync;
  renameSync: typeof renameSync;
  rmdirSync: typeof rmdirSync;
  symlinkSync: typeof symlinkSync;
  truncateSync: typeof truncateSync;
  ftruncateSync: typeof ftruncateSync;
  fsyncSync: typeof fsyncSync;
  fdatasyncSync: typeof fdatasyncSync;
  linkSync: typeof linkSync;
  unlinkSync: typeof unlinkSync;
  accessSync: typeof accessSync;
  // The l-variants: an operation that reaches the daemon on a symlink's
  // own path is about the link. Following it would act on whatever the
  // link points at, which can be outside the local root.
  lutimesSync: typeof lutimesSync;
  chmodSync: typeof chmodSync;
  chownSync: typeof chownSync;
  lchownSync: typeof lchownSync;
}

const REAL_FS: PassthroughFs = {
  openSync,
  closeSync,
  readSync,
  writeSync,
  fstatSync,
  statSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  truncateSync,
  ftruncateSync,
  fsyncSync,
  fdatasyncSync,
  linkSync,
  unlinkSync,
  accessSync,
  lutimesSync,
  chmodSync,
  chownSync,
  lchownSync,
};

/** Counters reported on `/__computerd/stats`. */
export interface PassthroughStats {
  /** Paths served from local disk rather than the VFS. */
  readonly localOps: number;
  /** Open local file handles. */
  readonly openHandles: number;
  /** Renames refused with EXDEV for crossing the boundary. */
  readonly crossLayerRenames: number;
}

export interface LocalPassthrough {
  readonly ops: FuseOps;
  readonly stats: () => PassthroughStats;
}

/**
 * Wraps `ops` so local-only paths are served from `root`.
 *
 * Returns the source object untouched when the ignore set is empty, so
 * a deployment that has not configured MOUNT_IGNORE pays nothing — not
 * a wrapper, not a branch, not an allocation.
 */
export function withLocalPassthrough(
  ops: FuseOps,
  options: LocalPassthroughOptions,
): LocalPassthrough {
  if (options.ignore.isEmpty) {
    return {
      ops,
      stats: () => ({
        localOps: 0,
        openHandles: 0,
        crossLayerRenames: 0,
      }),
    };
  }

  const fs = options.fs ?? REAL_FS;
  const root = options.root.replace(/\/+$/, "");
  const mountRoot = normalizeMount(options.mountPoint ?? "/");

  let localOps = 0;
  let crossLayerRenames = 0;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  // No cache. The ignore set is a handful of entries and the test is a
  // prefix comparison against each, which costs about what a cache
  // lookup would. A per-path cache grows with the dependency tree and
  // has to be invalidated on every rename and rmdir to stay correct.
  const isLocal = (path: string): boolean => {
    const relative = toRelative(path, mountRoot);
    if (relative === "") return false;
    return options.ignore.ignores(relative);
  };

  const localPath = (path: string): string => join(root, toRelative(path, mountRoot));

  // Handles are allocated from a high range so they cannot collide with
  // the VFS driver's, which counts up from 1. A handle that crossed
  // layers would read one file and write another.
  const LOCAL_HANDLE_BASE = 0x4000_0000;
  let nextHandle = LOCAL_HANDLE_BASE;
  const handles = new Map<number, { fd: number; path: string }>();
  const isLocalHandle = (fh: number): boolean => fh >= LOCAL_HANDLE_BASE;

  const ensureParent = (target: string): void => {
    const parent = dirname(target);
    try {
      fs.mkdirSync(parent, { recursive: true, mode: DEFAULT_DIR_MODE });
      options.onMaterialize?.(parent);
    } catch (error) {
      if (errnoOf(error) !== "EEXIST") throw error;
    }
  };

  const wrapped: FuseOps = {
    ...ops,

    readdir(path, cb) {
      if (!isLocal(path)) {
        // A VFS directory may still contain local-only children: the
        // entries live on disk but the parent does not. Merge both
        // sides so `ls` shows what a command inside the container sees.
        ops.readdir(path, (code, names) => {
          if (code !== 0) {
            cb(code, names);
            return;
          }
          const extra = localChildren(path);
          if (extra.length === 0) {
            cb(0, names);
            return;
          }
          const merged = new Set([...(names ?? []), ...extra]);
          cb(0, [...merged]);
        });
        return;
      }
      localOps += 1;
      try {
        cb(0, fs.readdirSync(localPath(path)));
      } catch (error) {
        cb(toErrno(error), []);
      }
    },

    getattr(path, cb) {
      if (!isLocal(path)) {
        ops.getattr(path, cb);
        return;
      }
      localOps += 1;
      try {
        cb(0, statToFuse(fs.lstatSync(localPath(path))));
      } catch (error) {
        cb(toErrno(error), null);
      }
    },

    fgetattr(path, fh, cb) {
      if (!isLocalHandle(fh)) {
        ops.fgetattr(path, fh, cb);
        return;
      }
      const handle = handles.get(fh);
      if (handle === undefined) {
        cb(ERRNO.EBADF, null);
        return;
      }
      localOps += 1;
      try {
        cb(0, statToFuse(fs.fstatSync(handle.fd)));
      } catch (error) {
        cb(toErrno(error), null);
      }
    },

    open(path, flags, cb) {
      if (!isLocal(path)) {
        ops.open(path, flags, cb);
        return;
      }
      localOps += 1;
      try {
        const target = localPath(path);
        // O_CREAT is not implied by open(2) here; the kernel sends
        // create() for that. But a flag set including O_TRUNC still has
        // to reach the real file, so the flags are passed through as-is.
        const fd = fs.openSync(target, flags);
        cb(0, allocateHandle(fd, path));
      } catch (error) {
        cb(toErrno(error), 0);
      }
    },

    opendir(path, flags, cb) {
      if (!isLocal(path)) {
        ops.opendir(path, flags, cb);
        return;
      }
      localOps += 1;
      // Directory handles carry no fd: readdir re-resolves by path, and
      // holding an O_PATH fd per open directory would leak under a
      // recursive walk of a large dependency tree. The path is still
      // checked now, so a missing directory fails at opendir(3) the way
      // it would on any other filesystem.
      try {
        if (!fs.statSync(localPath(path)).isDirectory()) {
          cb(ERRNO.ENOTDIR, 0);
          return;
        }
      } catch (error) {
        cb(toErrno(error), 0);
        return;
      }
      cb(0, allocateHandle(-1, path));
    },

    create(path, mode, cb) {
      if (!isLocal(path)) {
        ops.create(path, mode, cb);
        return;
      }
      localOps += 1;
      try {
        const target = localPath(path);
        ensureParent(target);
        const fd = fs.openSync(
          target,
          fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC,
          mode === 0 ? DEFAULT_FILE_MODE : mode,
        );
        cb(0, allocateHandle(fd, path));
      } catch (error) {
        cb(toErrno(error), 0);
      }
    },

    read(path, fh, buffer, length, position, cb) {
      if (!isLocalHandle(fh)) {
        ops.read(path, fh, buffer, length, position, cb);
        return;
      }
      const handle = handles.get(fh);
      if (handle === undefined) {
        cb(ERRNO.EBADF);
        return;
      }
      localOps += 1;
      try {
        cb(fs.readSync(handle.fd, buffer, 0, length, position));
      } catch (error) {
        cb(toErrno(error));
      }
    },

    write(path, fh, buffer, length, position, cb) {
      if (!isLocalHandle(fh)) {
        ops.write(path, fh, buffer, length, position, cb);
        return;
      }
      const handle = handles.get(fh);
      if (handle === undefined) {
        cb(ERRNO.EBADF);
        return;
      }
      localOps += 1;
      try {
        cb(fs.writeSync(handle.fd, buffer, 0, length, position));
      } catch (error) {
        cb(toErrno(error));
      }
    },

    release(path, fh, cb) {
      if (!isLocalHandle(fh)) {
        ops.release(path, fh, cb);
        return;
      }
      const handle = handles.get(fh);
      handles.delete(fh);
      if (handle === undefined || handle.fd < 0) {
        cb(0);
        return;
      }
      try {
        fs.closeSync(handle.fd);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    releasedir(path, fh, cb) {
      if (!isLocalHandle(fh)) {
        ops.releasedir(path, fh, cb);
        return;
      }
      handles.delete(fh);
      cb(0);
    },

    flush(path, fh, cb) {
      if (!isLocalHandle(fh)) {
        ops.flush(path, fh, cb);
        return;
      }
      // Nothing is buffered on this side; the write already reached the
      // kernel. Reporting success is honest here in a way it would not
      // be for the VFS path.
      cb(0);
    },

    fsync(path, fh, datasync, cb) {
      if (!isLocalHandle(fh)) {
        ops.fsync(path, fh, datasync, cb);
        return;
      }
      const handle = handles.get(fh);
      if (handle === undefined || handle.fd < 0) {
        cb(ERRNO.EBADF);
        return;
      }
      localOps += 1;
      try {
        if (datasync !== 0) fs.fdatasyncSync(handle.fd);
        else fs.fsyncSync(handle.fd);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    truncate(path, size, cb) {
      if (!isLocal(path)) {
        ops.truncate(path, size, cb);
        return;
      }
      localOps += 1;
      try {
        fs.truncateSync(localPath(path), size);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    ftruncate(path, fh, size, cb) {
      if (!isLocalHandle(fh)) {
        ops.ftruncate(path, fh, size, cb);
        return;
      }
      // By descriptor, not by path: the file may have been renamed or
      // replaced since it was opened.
      const handle = handles.get(fh);
      if (handle === undefined || handle.fd < 0) {
        cb(ERRNO.EBADF);
        return;
      }
      localOps += 1;
      try {
        fs.ftruncateSync(handle.fd, size);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    unlink(path, cb) {
      if (!isLocal(path)) {
        ops.unlink(path, cb);
        return;
      }
      localOps += 1;
      try {
        fs.unlinkSync(localPath(path));
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    mkdir(path, mode, cb) {
      if (!isLocal(path)) {
        ops.mkdir(path, mode, cb);
        return;
      }
      localOps += 1;
      try {
        const target = localPath(path);
        ensureParent(target);
        fs.mkdirSync(target, { mode: mode === 0 ? DEFAULT_DIR_MODE : mode });
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    rmdir(path, cb) {
      if (!isLocal(path)) {
        ops.rmdir(path, cb);
        return;
      }
      localOps += 1;
      try {
        fs.rmdirSync(localPath(path));
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    rename(source, destination, cb) {
      const sourceLocal = isLocal(source);
      const destinationLocal = isLocal(destination);

      if (!sourceLocal && !destinationLocal) {
        ops.rename(source, destination, cb);
        return;
      }

      if (sourceLocal !== destinationLocal) {
        // Cross-layer. EXDEV is the honest answer: the two sides are
        // different filesystems and the operation cannot be atomic.
        // Copying here would make a non-atomic operation look atomic,
        // and a crash mid-copy would leave a half-written file where
        // the caller was promised all-or-nothing. EXDEV is what rename(2)
        // returns between any two filesystems, so tools such as mv
        // already know to copy instead.
        //
        // The errno is all the kernel can carry, and "cross-device
        // link" on a path that is plainly not a device is the kind of
        // message an operator loses an afternoon to. So the guidance
        // goes to the log instead -- once per mount, because a build
        // that does this does it in a loop and a per-rename line would
        // bury everything else.
        reportCrossLayerRename(source, destination, sourceLocal);
        cb(ERRNO.EXDEV);
        return;
      }

      localOps += 1;
      try {
        const target = localPath(destination);
        ensureParent(target);
        fs.renameSync(localPath(source), target);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    chmod(path, mode, cb) {
      if (!isLocal(path)) {
        ops.chmod(path, mode, cb);
        return;
      }
      localOps += 1;
      try {
        fs.chmodSync(localPath(path), mode);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    chown(path, uid, gid, cb) {
      if (!isLocal(path)) {
        ops.chown(path, uid, gid, cb);
        return;
      }
      localOps += 1;
      try {
        fs.lchownSync(localPath(path), uid, gid);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    utimens(path, atime, mtime, cb) {
      if (!isLocal(path)) {
        ops.utimens(path, atime, mtime, cb);
        return;
      }
      localOps += 1;
      try {
        fs.lutimesSync(localPath(path), atime / 1000, mtime / 1000);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    readlink(path, cb) {
      if (!isLocal(path)) {
        ops.readlink(path, cb);
        return;
      }
      localOps += 1;
      try {
        // Stored verbatim. The link target is not interpreted here, and
        // ignored-ness was already decided on the lookup path before any
        // resolution, so a symlink cannot move a path between layers.
        cb(0, fs.readlinkSync(localPath(path)) as string);
      } catch (error) {
        cb(toErrno(error), "");
      }
    },

    symlink(target, path, cb) {
      if (!isLocal(path)) {
        ops.symlink(target, path, cb);
        return;
      }
      localOps += 1;
      try {
        const destination = localPath(path);
        ensureParent(destination);
        fs.symlinkSync(target, destination);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    access(path, mode, cb) {
      if (!isLocal(path)) {
        ops.access(path, mode, cb);
        return;
      }
      localOps += 1;
      try {
        fs.accessSync(localPath(path), mode);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    link(source, destination, cb) {
      const sourceLocal = isLocal(source);
      const destinationLocal = isLocal(destination);

      if (!sourceLocal && !destinationLocal) {
        ops.link(source, destination, cb);
        return;
      }

      // A hardlink is one file under two names, so both names have to be
      // on the same filesystem. Across the boundary that is impossible,
      // and EXDEV is what link(2) returns for it anywhere else.
      if (sourceLocal !== destinationLocal) {
        cb(ERRNO.EXDEV);
        return;
      }

      localOps += 1;
      try {
        const target = localPath(destination);
        ensureParent(target);
        fs.linkSync(localPath(source), target);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },
  };

  function allocateHandle(fd: number, path: string): number {
    const handle = nextHandle++;
    handles.set(handle, { fd, path });
    return handle;
  }

  function reportCrossLayerRename(
    source: string,
    destination: string,
    sourceIsLocal: boolean,
  ): void {
    crossLayerRenames += 1;
    if (crossLayerRenames > 1) return;
    const localSide = sourceIsLocal ? source : destination;
    const syncedSide = sourceIsLocal ? destination : source;
    // Name the entry to add, not just the paths. The fix is almost
    // always "ignore the staging directory too": build tools write into
    // a sibling and rename into place, so a destination that is
    // local-only while its staging path is not produces exactly this.
    const suggestion = toRelative(syncedSide, mountRoot) || syncedSide;
    warn(
      `computerd: rename ${source} -> ${destination} crossed the local-only ` +
        `boundary and returned EXDEV. ${localSide} is container-local ` +
        `(MOUNT_IGNORE), ${syncedSide} is synced to the workspace; a rename ` +
        `between them cannot be atomic, so it is refused rather than ` +
        `silently copied. Tools such as mv copy instead, but a program ` +
        `calling rename directly (Node's fs.rename, Go's os.Rename) sees ` +
        `the error. To ` +
        `keep the rename atomic, add "${suggestion}" to MOUNT_IGNORE as ` +
        `well. Further occurrences are not logged.`,
    );
  }

  function localChildren(path: string): string[] {
    const relative = toRelative(path, mountRoot);
    const names: string[] = [];
    for (const entry of options.ignore.paths) {
      const parent = posix.dirname(entry);
      const normalizedParent = parent === "." ? "" : parent;
      if (normalizedParent !== relative) continue;
      // Only list it if it has actually been created on disk. An
      // unconfigured-but-unused entry should not appear as a phantom
      // directory in a listing.
      try {
        fs.lstatSync(join(root, entry));
        names.push(posix.basename(entry));
      } catch {
        // Not materialized yet; nothing to show.
      }
    }
    return names;
  }

  return {
    ops: wrapped,
    stats: () => ({
      localOps,
      openHandles: handles.size,
      crossLayerRenames,
    }),
  };
}

function toRelative(path: string, mountRoot: string): string {
  let value = path;
  if (mountRoot !== "/" && (value === mountRoot || value.startsWith(`${mountRoot}/`))) {
    value = value.slice(mountRoot.length);
  }
  while (value.startsWith("/")) value = value.slice(1);
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

function normalizeMount(mountPoint: string): string {
  const trimmed = mountPoint.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function statToFuse(stat: Stats): FuseStat {
  return {
    mtime: stat.mtime,
    atime: stat.atime,
    ctime: stat.ctime,
    size: stat.size,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    nlink: stat.nlink,
    ino: stat.ino,
    blksize: stat.blksize,
    blocks: stat.blocks,
  };
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function toErrno(error: unknown): number {
  const code = errnoOf(error);
  switch (code) {
    case "ENOENT":
      return ERRNO.ENOENT;
    case "EEXIST":
      return ERRNO.EEXIST;
    case "ENOTDIR":
      return ERRNO.ENOTDIR;
    case "EISDIR":
      return ERRNO.EISDIR;
    case "ENOTEMPTY":
      return ERRNO.ENOTEMPTY;
    case "EACCES":
      return ERRNO.EACCES;
    case "EPERM":
      return ERRNO.EPERM;
    case "EINVAL":
      return ERRNO.EINVAL;
    case "EXDEV":
      return ERRNO.EXDEV;
    case "EBADF":
      return ERRNO.EBADF;
    default:
      return ERRNO.EIO;
  }
}
