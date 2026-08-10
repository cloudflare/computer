import { writeFileSync as nodeWriteFileSync } from "node:fs";
import { posix } from "node:path";
import type { FUSEBackend } from "./backend.js";
import { buildFuseOptionString } from "./options.js";
import { createFuseTracer, type FuseTracer, wrapFuseOpsWithTracer } from "./tracer.js";
import type { NodeVirtualFileSystem } from "./vfs.js";

const ERRNO = {
  ENOENT: -2,
  EIO: -5,
  EEXIST: -17,
  ENOTDIR: -20,
  EISDIR: -21,
  EINVAL: -22,
  EPERM: -1,
  EFBIG: -27,
  EROFS: -30,
  ENOTEMPTY: -39,
  ENODATA: -61,
  ENOSYS: -38,
} as const;

// Cap per-file in-memory size so a runaway client can't OOM the daemon.
// Sized to be comfortable for source trees while staying well below
// typical container memory limits.
const MAX_FILE_BYTES = 256 * 1024 * 1024;

// POSIX st_blocks counts allocation in fixed 512-byte units regardless
// of the filesystem's logical block size, so consumers like GNU `du`
// (which reads st_blocks, not st_size) compute usage against this
// constant. A getattr that omits blocks makes the kernel surface
// st_blocks=0 and `du` reports zero usage for the whole mount.
const STAT_BLOCK_SIZE = 512;

// st_blksize is the preferred I/O block size, not the st_blocks unit.
// Match what statfs advertises (bsize: 4096) and what the backing VFS
// reports so a fabricated stat stays consistent with a persisted one.
const PREFERRED_IO_BLOCK_SIZE = 4096;

function blocksForSize(size: number): number {
  return size <= 0 ? 0 : Math.ceil(size / STAT_BLOCK_SIZE);
}

type StatusCallback = (errnoOrBytes: number) => void;
type ResultCallback<T> = (errno: number, result: T) => void;
type NotImplementedOperation = (...args: unknown[]) => void;

export interface FuseOps {
  init(cb?: StatusCallback): void;
  error: NotImplementedOperation;
  readdir(path: string, cb: ResultCallback<string[]>): void;
  getattr(path: string, cb: ResultCallback<FuseStat | null>): void;
  fgetattr(path: string, fh: number, cb: ResultCallback<FuseStat | null>): void;
  open(path: string, flags: number, cb: ResultCallback<number>): void;
  opendir(path: string, flags: number, cb: ResultCallback<number>): void;
  create(path: string, mode: number, cb: ResultCallback<number>): void;
  read(
    path: string,
    fh: number,
    buffer: Buffer,
    length: number,
    position: number,
    cb: StatusCallback,
  ): void;
  write(
    path: string,
    fh: number,
    buffer: Buffer,
    length: number,
    position: number,
    cb: StatusCallback,
  ): void;
  release(path: string, fh: number, cb: StatusCallback): void;
  releasedir(path: string, fh: number, cb: StatusCallback): void;
  flush(path: string, fh: number, cb: StatusCallback): void;
  truncate(path: string, size: number, cb: StatusCallback): void;
  ftruncate(path: string, fh: number, size: number, cb: StatusCallback): void;
  unlink(path: string, cb: StatusCallback): void;
  mkdir(path: string, mode: number, cb: StatusCallback): void;
  rmdir(path: string, cb: StatusCallback): void;
  rename(source: string, destination: string, cb: StatusCallback): void;
  access(path: string, mode: number, cb: StatusCallback): void;
  statfs(path: string, cb: ResultCallback<Record<string, number>>): void;
  chmod(path: string, mode: number, cb: StatusCallback): void;
  chown(path: string, uid: number, gid: number, cb: StatusCallback): void;
  fsync(path: string, fh: number, datasync: number, cb: StatusCallback): void;
  fsyncdir(path: string, fh: number, datasync: number, cb: StatusCallback): void;
  utimens(path: string, atime: number, mtime: number, cb: StatusCallback): void;
  readlink(path: string, cb: ResultCallback<string>): void;
  mknod: NotImplementedOperation;
  setxattr(
    path: string,
    name: string,
    value: Buffer,
    position: number,
    flags: number,
    cb: StatusCallback,
  ): void;
  getxattr(path: string, name: string, position: number, cb: StatusCallback): void;
  listxattr(path: string, cb: ResultCallback<Buffer>): void;
  removexattr(path: string, name: string, cb: StatusCallback): void;
  link(source: string, destination: string, cb: StatusCallback): void;
  symlink(target: string, path: string, cb: StatusCallback): void;
  getBufferStats(): FuseBufferStats;
}

export interface FuseStat {
  mtime: Date;
  atime: Date;
  ctime: Date;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  ino: number;
  blksize: number;
  blocks: number;
}

export interface FuseBufferStats {
  entries: number;
  dirtyEntries: number;
  pendingCreates: number;
  capacityBytes: number;
  logicalBytes: number;
  dirtyLogicalBytes: number;
  openHandles: number;
  openPaths: number;
}

export interface FuseMount {
  unmount(): Promise<void>;
  // Returns the in-memory buffer and cache stats for the mounted
  // filesystem. Only present when the mount was created via mountFuse;
  // the shim does not expose this.
  getBufferStats?: () => FuseBufferStats;
}

interface FuseNativeInstance {
  mount(cb: (error: Error | null) => void): void;
  unmount(cb: (error: Error | null) => void): void;
  _fuseOptions(): string;
}

export function makeFUSEOps(vfs: NodeVirtualFileSystem, mountPoint = "/"): FuseOps {
  // The kernel hands us paths relative to the mount root ("/",
  // "/repo/a.txt"). The backing VFS stores them under `mountPoint`
  // (e.g. "/workspace", "/workspace/repo/a.txt") so reads through
  // the VFS surface and reads through a shell `cd /workspace`
  // agree on absolute paths. Translate each path argument at the
  // op boundary; everything below this function works in the VFS
  // namespace.
  const root = normaliseMountPoint(mountPoint);
  const toVfs = (path: string): string => {
    if (root === "/") return path;
    if (path === "/" || path === "") return root;
    return path.startsWith("/") ? `${root}${path}` : `${root}/${path}`;
  };

  const handles = new Map<number, string>();
  const fileOpenCounts = new Map<string, number>();
  let nextHandle = 1;

  const openHandle = (path: string): number => {
    const handle = nextHandle++;
    handles.set(handle, path);
    return handle;
  };

  const openFileHandle = (path: string): number => {
    fileOpenCounts.set(path, (fileOpenCounts.get(path) ?? 0) + 1);
    return openHandle(path);
  };

  const releaseFileHandle = (path: string): void => {
    const next = (fileOpenCounts.get(path) ?? 1) - 1;
    if (next <= 0) fileOpenCounts.delete(path);
    else fileOpenCounts.set(path, next);
  };

  // Sidecar metadata. platformatic VFS has no chmod/chown/utimes, so we store
  // overrides here and merge them into getattr.
  interface MetaOverride {
    mode?: number;
    uid?: number;
    gid?: number;
    atime?: Date;
    mtime?: Date;
  }
  const meta = new Map<string, MetaOverride>();
  const updateMeta = (path: string, patch: MetaOverride): void => {
    meta.set(path, { ...meta.get(path), ...patch });
  };

  // Buffer-backed file content store. Sidesteps platformatic VFS's
  // whole-file readFileSync/writeFileSync cycle, which is O(N²) for
  // sequential writes. We keep an in-memory Buffer per regular file with
  // amortized doubling on growth.
  interface DirtyRange {
    start: number;
    end: number;
  }

  interface RangedWriteVfs {
    writeFileRangesSync(
      path: string,
      data: Buffer,
      ranges: DirtyRange[],
      options?: { mode?: number },
    ): void;
  }

  interface DirectWriteVfs {
    createFileSync(path: string, options?: { mode?: number }): void;
    writeRangeSync(
      path: string,
      data: Buffer | Uint8Array,
      offset: number,
      options?: { mode?: number },
    ): number;
    truncateFileSync(path: string, size: number): void;
  }

  interface FileEntry {
    buf: Buffer; // capacity buffer (may be larger than size)
    size: number; // logical end-of-file
    dirty: boolean; // true when the buffer must be spilled into the VFS
    dirtyRanges: DirtyRange[];
    pendingCreate: boolean; // true until the first spill creates the VFS inode
    mode: number;
    // Frozen mtime for the pending-create window. pendingStat returns
    // this so consecutive stats of an unchanged inode look stable, and
    // auto_cache doesn't invalidate the page cache on every open of a
    // newly-created file. flushEntry doesn't use it — the persisted
    // mtime comes from writeFile's `now()` callback.
    pendingMtime: Date;
  }

  // Read the effective mode for an existing VFS inode at
  // lazy-hydrate time. Prefers an earlier chmod recorded in `meta`
  // (because chmod runs before any FileEntry exists for a path
  // that hadn't been written to yet) and falls back to the
  // persisted VFS mode. Without this, every spill of a non-pending-
  // create file would default to 0o644 and silently downgrade modes
  // set by writeFile or chmod.
  const modeFromVfs = (path: string): number => {
    const override = meta.get(path)?.mode;
    if (override !== undefined) return override & 0o7777;
    try {
      return vfs.lstatSync(toVfs(path)).mode & 0o7777;
    } catch {
      // Caller is about to fail too; default keeps the type honest.
      return 0o644;
    }
  };
  const files = new Map<string, FileEntry>();
  const rangedWriteVfs = vfs as NodeVirtualFileSystem & Partial<RangedWriteVfs>;
  const directWriteVfs = vfs as NodeVirtualFileSystem &
    Partial<DirectWriteVfs> & {
      chmodSync?: (path: string, mode: number) => void;
      readRangeSync?: (path: string, offset: number, length: number) => Uint8Array;
      openWriteBufferSync?: (path: string) => void;
      openWriteBufferForCreateSync?: (path: string, options?: { mode?: number }) => void;
      releaseWriteBufferSync?: (path: string) => void;
    };
  const hasDirectWrites =
    directWriteVfs.createFileSync !== undefined &&
    directWriteVfs.writeRangeSync !== undefined &&
    directWriteVfs.truncateFileSync !== undefined;
  const hasBufferedWrites =
    hasDirectWrites &&
    directWriteVfs.openWriteBufferSync !== undefined &&
    directWriteVfs.releaseWriteBufferSync !== undefined;
  const hasDeferredCreate =
    hasBufferedWrites && directWriteVfs.openWriteBufferForCreateSync !== undefined;
  const linkableVfs = vfs as NodeVirtualFileSystem & {
    linkSync?: (existingPath: string, newPath: string) => void;
  };
  const markDirty = (entry: FileEntry, start: number, end: number): void => {
    entry.dirty = true;
    if (start < end) entry.dirtyRanges.push({ start, end });
  };
  const parentPath = (path: string): string => {
    const parent = posix.dirname(path);
    return parent === "." ? "/" : parent;
  };
  const baseName = (path: string): string => posix.basename(path);
  const isPendingCreate = (path: string): boolean => files.get(path)?.pendingCreate === true;
  const exists = (path: string): boolean => isPendingCreate(path) || vfs.existsSync(toVfs(path));
  const getBufferStats = (): FuseBufferStats => {
    let dirtyEntries = 0;
    let pendingCreates = 0;
    let capacityBytes = 0;
    let logicalBytes = 0;
    let dirtyLogicalBytes = 0;
    for (const entry of files.values()) {
      if (entry.dirty) dirtyEntries++;
      if (entry.pendingCreate) pendingCreates++;
      capacityBytes += entry.buf.byteLength;
      logicalBytes += entry.size;
      if (entry.dirty) dirtyLogicalBytes += entry.size;
    }
    return {
      entries: files.size,
      dirtyEntries,
      pendingCreates,
      capacityBytes,
      logicalBytes,
      dirtyLogicalBytes,
      openHandles: handles.size,
      openPaths: fileOpenCounts.size,
    };
  };

  const pendingStat = (entry: FileEntry): FuseStat => {
    return {
      // Frozen from create() so consecutive stats of an unchanged
      // pending-create file return the same timestamps. Critical for
      // auto_cache: an advancing mtime would force the kernel to drop
      // the page cache on every open before the first flush lands.
      mtime: entry.pendingMtime,
      atime: entry.pendingMtime,
      ctime: entry.pendingMtime,
      size: entry.size,
      // S_IFREG | permission bits. The driver only ever stages regular
      // files this way; directories and symlinks go straight to the
      // VFS in their own ops.
      mode: 0o100000 | (entry.mode & 0o7777),
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      gid: typeof process.getgid === "function" ? process.getgid() : 0,
      nlink: 1,
      ino: 0,
      blksize: PREFERRED_IO_BLOCK_SIZE,
      blocks: blocksForSize(entry.size),
    };
  };
  // Returns true on success, false if `needed` exceeds MAX_FILE_BYTES.
  // Callers must surface the failure to FUSE as EFBIG.
  const ensureCapacity = (entry: FileEntry, needed: number): boolean => {
    if (needed > MAX_FILE_BYTES) return false;
    if (needed <= entry.buf.length) return true;
    let cap = Math.max(entry.buf.length * 2, 64 * 1024);
    while (cap < needed) cap *= 2;
    if (cap > MAX_FILE_BYTES) cap = MAX_FILE_BYTES;
    const next = Buffer.alloc(cap);
    entry.buf.copy(next, 0, 0, entry.size);
    entry.buf = next;
    return true;
  };

  // Spill an in-memory file buffer into the backing VFS. The
  // driver keeps writes in `files` for performance; the VFS only
  // sees the empty inode create() registered up front. Anything
  // that reads through the VFS surface (capnweb RPC's pullOnce,
  // node:fs callers in tests, host-side @platformatic/vfs
  // consumers) sees an empty file until this runs.
  //
  // Called from release/flush/fsync — the FUSE ops a well-behaved
  // client uses to mark a write durable. write itself stays
  // buffer-only so a burst of small writes doesn't re-chunk and
  // re-hash on every syscall.
  //
  // Returns errno on failure so callers can surface it to the
  // kernel; returns 0 on success or when there's nothing to do.
  const flushEntry = (path: string): number => {
    const entry = files.get(path);
    if (entry === undefined || !entry.dirty) return 0;
    try {
      const data = entry.buf.subarray(0, entry.size);
      // Pass the cached mode so writeFile doesn't fall back to its
      // 0o644 default. Without this, a chmod between create/open and
      // flush would land on the FUSE-side meta override but never
      // reach the persisted VFS row, so RPC consumers would see the
      // wrong mode.
      const writeOpts = { mode: entry.mode & 0o7777 };
      if (rangedWriteVfs.writeFileRangesSync !== undefined && entry.dirtyRanges.length > 0) {
        rangedWriteVfs.writeFileRangesSync(toVfs(path), data, entry.dirtyRanges, writeOpts);
      } else {
        vfs.writeFileSync(toVfs(path), data, writeOpts);
      }
      entry.dirty = false;
      entry.dirtyRanges = [];
      entry.pendingCreate = false;
      return 0;
    } catch (error) {
      return toErrno(error);
    }
  };

  const truncatePath = (path: string, size: number, cb: StatusCallback): void => {
    if (!exists(path)) {
      cb(ERRNO.ENOENT);
      return;
    }
    let entry = files.get(path);
    if (entry === undefined) {
      if (hasDirectWrites) {
        if (size > MAX_FILE_BYTES) {
          cb(ERRNO.EFBIG);
          return;
        }
        try {
          directWriteVfs.truncateFileSync?.(toVfs(path), size);
          cb(0);
        } catch (error) {
          cb(toErrno(error));
        }
        return;
      }
      try {
        const data = vfs.readFileSync(toVfs(path));
        entry = {
          buf: data,
          size: data.length,
          dirty: false,
          dirtyRanges: [],
          pendingCreate: false,
          mode: modeFromVfs(path),
          pendingMtime: new Date(),
        };
        files.set(path, entry);
      } catch (error) {
        cb(toErrno(error));
        return;
      }
    }
    if (size > entry.size) {
      if (!ensureCapacity(entry, size)) {
        cb(ERRNO.EFBIG);
        return;
      }
      entry.buf.fill(0, entry.size, size);
    }
    const previousSize = entry.size;
    entry.size = size;
    markDirty(entry, Math.min(previousSize, size), Math.max(previousSize, size));
    cb(0);
  };

  const warnedOperations = new Set<string>();
  const notImplemented = (operation: string): NotImplementedOperation => {
    return (...args: unknown[]) => {
      if (!warnedOperations.has(operation)) {
        warnedOperations.add(operation);
        console.warn(`computerd: FUSE op ${operation} not implemented; returning ENOSYS`);
      }
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        (cb as (errno: number, ...rest: unknown[]) => void)(ERRNO.ENOSYS);
      }
    };
  };

  return {
    init(cb) {
      cb?.(0);
    },

    getBufferStats,

    error: notImplemented("error"),

    readdir(path, cb) {
      try {
        const entries = new Set(vfs.readdirSync(toVfs(path)));
        for (const [pendingPath, entry] of files) {
          if (entry.pendingCreate && parentPath(pendingPath) === path)
            entries.add(baseName(pendingPath));
        }
        cb(0, [...entries]);
      } catch (error) {
        cb(toErrno(error), []);
      }
    },

    getattr(path, cb) {
      try {
        const entry = files.get(path);
        const stat =
          entry?.pendingCreate === true ? pendingStat(entry) : statNode(vfs.lstatSync(toVfs(path)));
        // File content lives outside the VFS, so prefer our size. The
        // buffered size can outrun the persisted inode before a spill,
        // so recompute block accounting from it to keep st_blocks
        // coherent with the size the kernel sees.
        if (entry !== undefined) {
          stat.size = entry.size;
          stat.blocks = blocksForSize(entry.size);
        }
        const override = meta.get(path);
        if (override) {
          if (override.mode !== undefined) {
            stat.mode = (stat.mode & 0o170000) | (override.mode & 0o7777);
          }
          if (override.uid !== undefined) stat.uid = override.uid;
          if (override.gid !== undefined) stat.gid = override.gid;
          if (override.atime) stat.atime = override.atime;
          if (override.mtime) stat.mtime = override.mtime;
        }
        cb(0, stat);
      } catch (error) {
        cb(toErrno(error), null);
      }
    },

    fgetattr(path, _fh, cb) {
      this.getattr(path, cb);
    },

    open(path, _flags, cb) {
      try {
        const entry = files.get(path);
        if (entry?.pendingCreate === true) {
          cb(0, openFileHandle(path));
          return;
        }
        const stat = vfs.statSync(toVfs(path));
        if (stat.isDirectory()) {
          cb(ERRNO.EISDIR, 0);
          return;
        }
        if (hasBufferedWrites) {
          directWriteVfs.openWriteBufferSync?.(toVfs(path));
        }
        cb(0, openFileHandle(path));
      } catch (error) {
        cb(toErrno(error), 0);
      }
    },

    opendir(path, _flags, cb) {
      try {
        const stat = vfs.statSync(toVfs(path));
        if (!stat.isDirectory()) {
          cb(ERRNO.ENOTDIR, 0);
          return;
        }

        cb(0, openHandle(path));
      } catch (error) {
        cb(toErrno(error), 0);
      }
    },

    create(path, mode, cb) {
      try {
        if (exists(path)) {
          cb(ERRNO.EEXIST, 0);
          return;
        }
        if (hasDeferredCreate) {
          // Single transaction at release time: defer the inode INSERT
          // and the chunk commit into one round trip.
          directWriteVfs.openWriteBufferForCreateSync?.(toVfs(path), { mode });
          cb(0, openFileHandle(path));
          return;
        }
        if (hasDirectWrites) {
          directWriteVfs.createFileSync?.(toVfs(path), { mode });
          if (hasBufferedWrites) {
            directWriteVfs.openWriteBufferSync?.(toVfs(path));
          }
          cb(0, openFileHandle(path));
          return;
        }
        // Defer the VFS inode write until flush/release/fsync. Most create
        // workloads immediately write content, so persisting an empty file here
        // doubles provider work for tiny files.
        //
        // dirty=true with an empty dirtyRanges array is deliberate: it
        // routes flushEntry to the whole-file writeFileSync path, which
        // is what registers the inode the first time. The subsequent
        // write() / truncate() ops append real ranges.
        files.set(path, {
          buf: Buffer.alloc(0),
          size: 0,
          dirty: true,
          dirtyRanges: [],
          pendingCreate: true,
          mode,
          pendingMtime: new Date(),
        });
        cb(0, openFileHandle(path));
      } catch (error) {
        cb(toErrno(error), 0);
      }
    },

    read(path, _fh, buffer, length, position, cb) {
      let entry = files.get(path);
      if (entry === undefined) {
        if (hasDirectWrites && directWriteVfs.readRangeSync !== undefined) {
          try {
            const slice = directWriteVfs.readRangeSync(toVfs(path), position, length);
            if (slice.byteLength === 0) {
              cb(0);
              return;
            }
            buffer.set(slice, 0);
            cb(slice.byteLength);
          } catch (error) {
            cb(toErrno(error));
          }
          return;
        }
        try {
          const data = vfs.readFileSync(toVfs(path));
          if (hasDirectWrites) {
            if (position >= data.length) {
              cb(0);
              return;
            }
            const end = Math.min(position + length, data.length);
            data.copy(buffer, 0, position, end);
            cb(end - position);
            return;
          }
          // File was created out-of-band (e.g. before this driver started
          // tracking it). Lazy-hydrate from the VFS, carrying the
          // persisted mode forward so a later flush doesn't downgrade it.
          entry = {
            buf: data,
            size: data.length,
            dirty: false,
            dirtyRanges: [],
            pendingCreate: false,
            mode: modeFromVfs(path),
            pendingMtime: new Date(),
          };
          files.set(path, entry);
        } catch (error) {
          cb(toErrno(error));
          return;
        }
      }
      if (position >= entry.size) {
        cb(0);
        return;
      }
      const end = Math.min(position + length, entry.size);
      entry.buf.copy(buffer, 0, position, end);
      cb(end - position);
    },

    write(path, _fh, buffer, length, position, cb) {
      let entry = files.get(path);
      if (entry === undefined) {
        if (!exists(path)) {
          cb(ERRNO.ENOENT);
          return;
        }
        if (hasDirectWrites) {
          if (position + length > MAX_FILE_BYTES) {
            cb(ERRNO.EFBIG);
            return;
          }
          try {
            cb(
              directWriteVfs.writeRangeSync?.(toVfs(path), buffer.subarray(0, length), position, {
                mode: modeFromVfs(path),
              }) ?? ERRNO.ENOSYS,
            );
          } catch (error) {
            cb(toErrno(error));
          }
          return;
        }
        try {
          const data = vfs.readFileSync(toVfs(path));
          entry = {
            buf: data,
            size: data.length,
            dirty: false,
            dirtyRanges: [],
            pendingCreate: false,
            mode: modeFromVfs(path),
            pendingMtime: new Date(),
          };
          files.set(path, entry);
        } catch (error) {
          cb(toErrno(error));
          return;
        }
      }
      const end = position + length;
      if (!ensureCapacity(entry, end)) {
        cb(ERRNO.EFBIG);
        return;
      }
      buffer.copy(entry.buf, position, 0, length);
      if (end > entry.size) entry.size = end;
      markDirty(entry, position, end);
      cb(length);
    },

    release(path, fh, cb) {
      handles.delete(fh);
      releaseFileHandle(path);
      if (hasBufferedWrites) {
        try {
          directWriteVfs.releaseWriteBufferSync?.(toVfs(path));
          cb(0);
        } catch (error) {
          cb(toErrno(error));
        }
        return;
      }
      // Last chance to make the buffered writes durable in the
      // VFS — the kernel won't call write() again on this fh.
      // Multi-open is fine: the next release on a different fh
      // pointing at the same buffer re-spills the same bytes,
      // which writeFileSync handles idempotently.
      const errno = flushEntry(path);
      if (errno === 0 && (fileOpenCounts.get(path) ?? 0) === 0) {
        const entry = files.get(path);
        if (entry !== undefined && !entry.dirty) {
          for (const [candidatePath, candidateEntry] of files) {
            if (candidateEntry === entry && (fileOpenCounts.get(candidatePath) ?? 0) === 0) {
              files.delete(candidatePath);
            }
          }
        }
      }
      cb(errno);
    },

    releasedir(_path, fh, cb) {
      handles.delete(fh);
      cb(0);
    },

    flush(path, _fh, cb) {
      // Linux close(2) drives this op once per close, before
      // release. Spilling here means a process that close()s
      // without unlink-ing sees its bytes through the VFS surface
      // immediately, without waiting for the kernel to call release.
      cb(flushEntry(path));
    },

    truncate(path, size, cb) {
      truncatePath(path, size, cb);
    },

    ftruncate(path, _fh, size, cb) {
      truncatePath(path, size, cb);
    },

    unlink(path, cb) {
      try {
        if (!isPendingCreate(path)) vfs.unlinkSync(toVfs(path));
        meta.delete(path);
        files.delete(path);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    mkdir(path, mode, cb) {
      try {
        vfs.mkdirSync(toVfs(path), { mode });
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    rmdir(path, cb) {
      try {
        vfs.rmdirSync(toVfs(path));
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    rename(source, destination, cb) {
      try {
        if (isPendingCreate(source)) {
          // Source hasn't been persisted yet, so there's nothing for
          // the VFS to move. POSIX rename(2) overwrites a regular file
          // at the destination; honour that here by unlinking any
          // pre-existing destination inode and dropping any pending
          // entry that was staged at it. The next flush of the
          // remapped buffer will create the dest inode fresh.
          const destPending = isPendingCreate(destination);
          if (!destPending && vfs.existsSync(toVfs(destination))) {
            vfs.unlinkSync(toVfs(destination));
          }
          if (destPending) {
            files.delete(destination);
          }
          meta.delete(destination);
        } else {
          vfs.renameSync(toVfs(source), toVfs(destination));
        }
        const m = meta.get(source);
        if (m !== undefined) {
          meta.delete(source);
          meta.set(destination, m);
        }
        const entry = files.get(source);
        if (entry !== undefined) {
          files.delete(source);
          files.set(destination, entry);
        }
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    access(path, mode, cb) {
      try {
        if (isPendingCreate(path)) {
          cb(0);
          return;
        }
        vfs.accessSync(toVfs(path), mode);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },

    statfs(_path, cb) {
      cb(0, {
        bsize: 4096,
        frsize: 4096,
        blocks: 1024 * 1024,
        bfree: 1024 * 1024,
        bavail: 1024 * 1024,
        files: 1024 * 1024,
        ffree: 1024 * 1024,
        favail: 1024 * 1024,
        fsid: 1,
        flag: 0,
        namemax: 255,
      });
    },

    chmod(path, mode, cb) {
      if (!exists(path)) {
        cb(ERRNO.ENOENT);
        return;
      }
      const entry = files.get(path);
      if (entry !== undefined) entry.mode = mode;
      updateMeta(path, { mode });
      if (entry === undefined && directWriteVfs.chmodSync !== undefined) {
        try {
          directWriteVfs.chmodSync(toVfs(path), mode);
        } catch (error) {
          cb(toErrno(error));
          return;
        }
      }
      cb(0);
    },

    chown(path, uid, gid, cb) {
      if (!exists(path)) {
        cb(ERRNO.ENOENT);
        return;
      }
      updateMeta(path, { uid, gid });
      cb(0);
    },

    fsync(path, _fh, _datasync, cb) {
      // fsync(2) is the documented user-facing flush. Spill
      // whatever's buffered so subsequent VFS reads see it.
      cb(flushEntry(path));
    },

    fsyncdir(_path, _fh, _datasync, cb) {
      cb(0);
    },

    utimens(path, atime, mtime, cb) {
      if (!vfs.existsSync(toVfs(path))) {
        cb(ERRNO.ENOENT);
        return;
      }
      // Note: with libfuse2/fuse-native, touch -a / touch -m alone do not
      // reach this op — the kernel/libfuse short-circuits when only one of
      // atime/mtime is provided (UTIME_OMIT). touch with both set works.
      updateMeta(path, { atime: new Date(atime), mtime: new Date(mtime) });
      cb(0);
    },
    readlink(path, cb) {
      try {
        cb(0, vfs.readlinkSync(toVfs(path)));
      } catch (error) {
        cb(toErrno(error), "");
      }
    },
    mknod: notImplemented("mknod"),

    setxattr(path, _name, _value, _position, _flags, cb) {
      cb(exists(path) ? 0 : ERRNO.ENOENT);
    },

    getxattr(path, _name, _position, cb) {
      cb(exists(path) ? ERRNO.ENODATA : ERRNO.ENOENT);
    },

    listxattr(path, cb) {
      cb(exists(path) ? 0 : ERRNO.ENOENT, Buffer.alloc(0));
    },

    removexattr(path, _name, cb) {
      cb(exists(path) ? ERRNO.ENODATA : ERRNO.ENOENT);
    },

    link(source, destination, cb) {
      try {
        if (linkableVfs.linkSync === undefined) {
          cb(ERRNO.ENOSYS);
          return;
        }
        const flushErrno = flushEntry(source);
        if (flushErrno !== 0) {
          cb(flushErrno);
          return;
        }
        linkableVfs.linkSync(toVfs(source), toVfs(destination));
        const entry = files.get(source);
        if (entry !== undefined) files.set(destination, entry);
        const override = meta.get(source);
        if (override !== undefined) meta.set(destination, override);
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },
    symlink(target, path, cb) {
      try {
        // Symlink target text is stored verbatim — applications
        // resolve it against the link's directory, and a link
        // created via FUSE already names paths in the mount
        // namespace.
        vfs.symlinkSync(target, toVfs(path));
        cb(0);
      } catch (error) {
        cb(toErrno(error));
      }
    },
  };
}

function normaliseMountPoint(mountPoint: string): string {
  if (!posix.isAbsolute(mountPoint)) {
    throw new Error(`mountPoint must be an absolute path, got ${JSON.stringify(mountPoint)}`);
  }
  const normalised = posix.normalize(mountPoint).replace(/\/+$/, "");
  return normalised === "" ? "/" : normalised;
}

export async function mountFuse(options: {
  backend?: FUSEBackend;
  mountPoint: string;
  vfs: NodeVirtualFileSystem;
}): Promise<FuseMount> {
  // biome-ignore lint/suspicious/noExplicitAny: fuse-native ships no types
  const fuseModule: any = await import("fuse-native");
  const Fuse = fuseModule.default ?? fuseModule;
  // Optional op tracing. `COMPUTERD_FUSE_TRACE=summary` records per-op call
  // counts and timings; the summary is emitted on SIGUSR2 and on
  // unmount, to stderr by default or to `COMPUTERD_FUSE_TRACE_FILE` when set.
  // Disabled means zero wrapping overhead — the unwrapped ops object
  // is handed to fuse-native directly.
  const traceMode = process.env.COMPUTERD_FUSE_TRACE;
  const tracer: FuseTracer | undefined = traceMode === "summary" ? createFuseTracer() : undefined;
  const baseOps = makeFUSEOps(options.vfs, options.mountPoint);
  const { getBufferStats: _getBufferStats, ...fuseOps } = baseOps;
  const ops =
    tracer === undefined
      ? fuseOps
      : wrapFuseOpsWithTracer(fuseOps as unknown as Record<string, unknown>, tracer);
  const fuse = new Fuse(options.mountPoint, ops, {
    autoUnmount: true,
    debug: false,
  }) as FuseNativeInstance;

  const emitTrace = (reason: string): void => {
    if (tracer === undefined) return;
    const json = tracer.formatJson();
    const target = process.env.COMPUTERD_FUSE_TRACE_FILE;
    if (target !== undefined && target !== "") {
      try {
        nodeWriteFileSync(target, `${json}\n`);
      } catch (error) {
        process.stderr.write(
          `computerd: failed to write FUSE trace to ${target} (${reason}): ${String(error)}\n${json}\n`,
        );
      }
      return;
    }
    process.stderr.write(`computerd: FUSE trace (${reason})\n${json}\n`);
  };

  if (tracer !== undefined) {
    process.on("SIGUSR2", () => emitTrace("SIGUSR2"));
  }

  // fuse-native (libfuse 2.9) doesn't expose big_writes/max_write/max_read
  // through opts, so monkey-patch _fuseOptions() to append them. big_writes
  // lets the kernel batch up to max_write bytes per FUSE op instead of the
  // default 4 KiB, cutting per-op round-trips ~32x on large sequential I/O.
  // buildFuseOptionString reads COMPUTERD_FUSE_* env vars; with none set it
  // emits the production-safe profile (auto_cache plus one-second
  // metadata timeouts) backed by the auto_cache contract tests.
  const origFuseOptions = fuse._fuseOptions.bind(fuse);
  const extraOpts = buildFuseOptionString(process.env);
  fuse._fuseOptions = (): string => {
    const base = origFuseOptions();
    return base ? `${base},${extraOpts}` : `-o${extraOpts}`;
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("FUSE mount timed out after 5s")), 5_000);
    fuse.mount((error: Error | null) => {
      clearTimeout(timer);
      if (error !== null) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  return {
    unmount() {
      return new Promise<void>((resolve, reject) => {
        fuse.unmount((error: Error | null) => {
          if (error !== null) {
            reject(error);
            return;
          }

          emitTrace("unmount");
          resolve();
        });
      });
    },
    getBufferStats: _getBufferStats,
  };
}

function statNode(stat: {
  mtime: Date;
  atime: Date;
  ctime: Date;
  size: number;
  mode: number;
  nlink?: number;
  ino?: number;
  blksize?: number;
  blocks?: number;
  isDirectory(): boolean;
}): FuseStat {
  return {
    mtime: stat.mtime,
    atime: stat.atime,
    ctime: stat.ctime,
    size: stat.size,
    mode: stat.mode,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    nlink: stat.nlink ?? (stat.isDirectory() ? 2 : 1),
    ino: stat.ino ?? 0,
    // Prefer provider-supplied block accounting when the VFS exposes
    // it; otherwise derive from size in 512-byte units so `du` and
    // other st_blocks consumers see real usage.
    blksize: stat.blksize ?? PREFERRED_IO_BLOCK_SIZE,
    blocks: stat.blocks ?? blocksForSize(stat.size),
  };
}

function toErrno(error: unknown): number {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  if (code === "ENOENT") return ERRNO.ENOENT;
  if (code === "EEXIST") return ERRNO.EEXIST;
  if (code === "ENOTDIR") return ERRNO.ENOTDIR;
  if (code === "EISDIR") return ERRNO.EISDIR;
  if (code === "ENOTEMPTY") return ERRNO.ENOTEMPTY;
  if (code === "EINVAL") return ERRNO.EINVAL;
  if (code === "EPERM") return ERRNO.EPERM;
  if (code === "EROFS") return ERRNO.EROFS;
  return ERRNO.EIO;
}
