declare namespace Fuse {
  export type Result = number | null | undefined;
  export type Int64 = number | bigint;
  export type Uint64 = number | bigint;
  export type FileHandle = Uint64;
  /** Can be null only when nullPathOk/noPath was enabled for handle-based operations. */
  export type HandlePath = string | null;

  export interface Timespec {
    readonly seconds: Int64;
    readonly nanoseconds: number;
  }

  export interface FileInfo {
    readonly flags: number;
    readonly writepage: boolean;
    readonly directIO: boolean;
    readonly keepCache: boolean;
    readonly flush: boolean;
    readonly nonseekable: boolean;
    readonly flockRelease: boolean;
    readonly fd: FileHandle;
    readonly lockOwner: Uint64;
  }

  export interface RequestContext {
    readonly uid: number;
    readonly gid: number;
    readonly pid: number;
    readonly umask: number;
    readonly fileInfo: Readonly<FileInfo> | null;
  }

  export interface Lock {
    readonly type: number;
    readonly whence: number;
    readonly start: Int64;
    readonly length: Int64;
    readonly pid: number;
  }

  export interface FileInfoResult {
    fd?: FileHandle;
    directIO?: boolean;
    keepCache?: boolean;
    nonseekable?: boolean;
    /**
     * Backing id from `backingOpen()`. When > 0 the kernel serves this
     * handle's reads and writes from the backing file directly, bypassing
     * the daemon. Cannot be combined with `keepCache` or `directIO`.
     */
    backingId?: number;
  }

  export interface PollHandle {
    readonly closed: boolean;
    notify(): boolean;
    close(): boolean;
  }

  export interface ConnectionInfo {
    readonly protoMajor: number;
    readonly protoMinor: number;
    readonly asyncRead: boolean;
    readonly maxWrite: number;
    readonly maxReadahead: number;
    /** Active maximum read size; equals the constructor maxRead value when configured. */
    readonly maxRead: number;
    readonly capable: number;
    readonly want: number;
    readonly maxBackground: number;
    readonly congestionThreshold: number;
  }

  export interface InitConfig {
    maxWrite?: number;
    maxReadahead?: number;
    maxBackground?: number;
    congestionThreshold?: number;
    want?: number;
    asyncRead?: boolean;
    /**
     * Maximum stacking depth permitted for a passthrough backing file.
     * Set to 1 when the backing store may live on overlayfs.
     */
    maxBackingStackDepth?: number;
  }

  export interface EnvironmentReport {
    readonly ok: true;
    readonly platform: 'linux' | 'darwin';
    readonly helper?: 'fusermount3';
    readonly helperVersion?: string | null;
    readonly device?: '/dev/fuse';
    readonly runtime?: string;
    readonly macfuseVersion?: string;
    readonly libfuseVersion?: string | null;
    readonly capabilities: Readonly<{
      statx: boolean;
    }>;
  }

  // Stats object produced by fuse-native index.js function getStatArray
  export interface Stats {
    mode?: number;
    uid?: number;
    gid?: number;
    size?: Uint64;
    dev?: Uint64;
    nlink?: Uint64;
    ino?: Uint64;
    rdev?: Uint64;
    blksize?: Uint64;
    blocks?: Uint64;
    atime?: Date | Int64 | Timespec;
    mtime?: Date | Int64 | Timespec;
    ctime?: Date | Int64 | Timespec;
  }

  export interface Statfs {
    bsize?: Uint64;
    frsize?: Uint64;
    blocks?: Uint64;
    bfree?: Uint64;
    bavail?: Uint64;
    files?: Uint64;
    ffree?: Uint64;
    favail?: Uint64;
    fsid?: Uint64;
    flag?: Uint64;
    namemax?: Uint64;
  }

  export interface CommonOperations {
    access?: (path: string, mode: number, cb: (err: Result) => void) => void;
    statfs?: (path: string, cb: (err: Result, stats?: Statfs) => void) => void;
    fgetattr?: (
        path: HandlePath,
        fd: FileHandle,
        cb: (err: Result, stat?: Stats) => void
    ) => void;
    getattr?: (
        path: HandlePath,
        cb: (err: Result, stat?: Stats) => void
    ) => void;
    flush?: (path: HandlePath, fd: FileHandle, cb: (err: Result) => void) => void;
    fsync?: (path: HandlePath, dataSync: boolean, fd: FileHandle, cb: (err: Result) => void) => void;
    fsyncdir?: (path: HandlePath, dataSync: boolean, fd: FileHandle, cb: (err: Result) => void) => void;
    truncate?: (path: HandlePath, size: Int64, cb: (err: Result) => void) => void;
    ftruncate?: (path: HandlePath, fd: FileHandle, size: Int64, cb: (err: Result) => void) => void;
    readlink?: (path: string, cb: (err: Result, linkName?: string) => void) => void;
    mknod?: (path: string, mode: number, dev: Uint64, cb: (err: Result) => void) => void;
    setxattr?: (
        path: string,
        name: string,
        value: Buffer,
        position: number,
        flags: number,
        cb: (err: Result) => void
    ) => void;
    getxattr?: (
        path: string,
        name: string,
        position: number,
        cb: (err: Result, value?: Buffer | null) => void
    ) => void;
    listxattr?: (path: string, cb: (err: Result, list?: string[]) => void) => void;
    removexattr?: (path: string, name: string, cb: (err: Result) => void) => void;
    open?: (
        path: string,
        flags: number,
        cb: (err: Result, result?: FileHandle | FileInfoResult) => void
    ) => void;
    opendir?: (
        path: string,
        flags: number,
        cb: (err: Result, result?: FileHandle | FileInfoResult) => void
    ) => void;
    // For every open() call there will be exactly one release() call with the same flags and
    // file handle. It is possible to have a file opened more than once, in which case only the
    // last release will mean, that no more reads/writes will happen on the file. The return
    // value of release is ignored.
    release?: (path: HandlePath, fd: FileHandle, cb: (err: Result) => void) => void;
    releasedir?: (path: HandlePath, fd: FileHandle, cb: (err: Result) => void) => void;
    unlink?: (path: string, cb: (err: Result) => void) => void;
    link?: (src: string, dest: string, cb: (err: Result) => void) => void;
    symlink?: (src: string, dest: string, cb: (err: Result) => void) => void;
    mkdir?: (path: string, mode: number, cb: (err: Result) => void) => void;
    rmdir?: (path: string, cb: (err: Result) => void) => void;
    destroy?: (cb: (err: Result) => void) => void;
    lock?: (
        path: HandlePath,
        fd: FileHandle,
        command: number,
        lock: Readonly<Lock>,
        cb: (err: Result, lock?: Lock) => void
    ) => void;
    bmap?: (
        path: string,
        blockSize: Uint64,
        index: Uint64,
        cb: (err: Result, index?: Uint64) => void
    ) => void;
    ioctl?: (
        path: HandlePath,
        fd: FileHandle,
        command: number,
        argument: Uint64,
        flags: number,
        data: Buffer,
        cb: (err: Result, output?: Buffer) => void
    ) => void;
    flock?: (
        path: HandlePath,
        fd: FileHandle,
        operation: number,
        cb: (err: Result) => void
    ) => void;
    fallocate?: (
        path: HandlePath,
        fd: FileHandle,
        mode: number,
        offset: Int64,
        length: Int64,
        cb: (err: Result) => void
    ) => void;
    copyFileRange?: (
        sourcePath: HandlePath,
        sourceFd: FileHandle,
        sourceOffset: Int64,
        destinationPath: HandlePath,
        destinationFd: FileHandle,
        destinationOffset: Int64,
        length: Uint64,
        flags: number,
        cb: (result: number | bigint) => void
    ) => void;
    lseek?: (
        path: HandlePath,
        fd: FileHandle,
        offset: Int64,
        whence: number,
        cb: (err: Result, offset?: Int64) => void
    ) => void;
  }

  export type OPERATIONS = CommonOperations & (
    | {
        init?: (cb: (err: Result) => void) => void;
        initWithConfig?: never;
      }
    | {
        init?: never;
        initWithConfig?: (
            connection: Readonly<ConnectionInfo>,
            cb: (err: Result, config?: InitConfig) => void
        ) => void;
      }
  ) & (
    | {
        readdir?: (path: HandlePath, cb: (err: Result, names?: string[], stats?: Stats[]) => void) => void;
        readdirPaged?: never;
      }
    | {
        readdir?: never;
        readdirPaged?: (
            path: HandlePath,
            fd: FileHandle,
            offset: Int64,
            cb: (err: Result, names?: string[], stats?: Stats[], nextOffsets?: Int64[]) => void
        ) => void;
      }
  ) & (
    | {
        create?: (
            path: string,
            mode: number,
            cb: (err: Result, result?: FileHandle | FileInfoResult) => void
        ) => void;
        createWithFlags?: never;
      }
    | {
        create?: never;
        createWithFlags?: (
            path: string,
            mode: number,
            flags: number,
            cb: (err: Result, result?: FileHandle | FileInfoResult) => void
        ) => void;
      }
  ) & (
    | {
        utimens?: (
            path: HandlePath,
            atime: Int64,
            mtime: Int64,
            cb: (err: Result) => void
        ) => void;
        utimensWithTimespec?: never;
        utimensWithHandle?: never;
      }
    | {
        utimens?: never;
        utimensWithTimespec?: (
            path: HandlePath,
            atime: Readonly<Timespec>,
            mtime: Readonly<Timespec>,
            cb: (err: Result) => void
        ) => void;
        utimensWithHandle?: never;
      }
    | {
        utimens?: never;
        utimensWithTimespec?: never;
        utimensWithHandle?: (
            path: HandlePath,
            fd: FileHandle,
            atime: Readonly<Timespec>,
            mtime: Readonly<Timespec>,
            cb: (err: Result) => void
        ) => void;
      }
  ) & (
    | {
        read?: (
            path: HandlePath,
            fd: FileHandle,
            buffer: Buffer,
            length: number,
            position: Int64,
            cb: (result: number) => void
        ) => void;
        readBuffer?: never;
      }
    | {
        read?: never;
        readBuffer?: (
            path: HandlePath,
            fd: FileHandle,
            length: number,
            position: Int64,
            cb: (err: Result, buffer?: Buffer) => void
        ) => void;
      }
  ) & (
    | {
        write?: (
            path: HandlePath,
            fd: FileHandle,
            buffer: Buffer,
            length: number,
            position: Int64,
            cb: (result: number) => void
        ) => void;
        writeBuffer?: never;
      }
    | {
        write?: never;
        writeBuffer?: (
            path: HandlePath,
            fd: FileHandle,
            buffer: Buffer,
            length: number,
            position: Int64,
            cb: (result: number) => void
        ) => void;
      }
  ) & (
    | {
        chown?: (
            path: HandlePath,
            uid: number,
            gid: number,
            cb: (err: Result) => void
        ) => void;
        chownWithHandle?: never;
      }
    | {
        chown?: never;
        chownWithHandle?: (
            path: HandlePath,
            fd: FileHandle,
            uid: number,
            gid: number,
            cb: (err: Result) => void
        ) => void;
      }
  ) & (
    | {
        chmod?: (
            path: HandlePath,
            mode: number,
            cb: (err: Result) => void
        ) => void;
        chmodWithHandle?: never;
      }
    | {
        chmod?: never;
        chmodWithHandle?: (
            path: HandlePath,
            fd: FileHandle,
            mode: number,
            cb: (err: Result) => void
        ) => void;
      }
  ) & (
    | {
        rename?: (
            src: string,
            dest: string,
            cb: (err: Result) => void
        ) => void;
        renameWithFlags?: never;
      }
    | {
        rename?: never;
        renameWithFlags?: (
            src: string,
            dest: string,
            flags: number,
            cb: (err: Result) => void
        ) => void;
      }
  ) & (
    | {
        poll?: (
            path: HandlePath,
            fd: FileHandle,
            cb: (err: Result, events?: number) => void
        ) => void;
        pollWithHandle?: never;
      }
    | {
        poll?: never;
        pollWithHandle?: (
            path: HandlePath,
            fd: FileHandle,
            handle: PollHandle | null,
            cb: (err: Result, events?: number) => void
        ) => void;
      }
  );

  export type OperationName =
    | 'init' | 'access' | 'statfs' | 'fgetattr' | 'getattr' | 'flush'
    | 'fsync' | 'fsyncdir' | 'readdir' | 'truncate' | 'ftruncate'
    | 'utimens' | 'readlink' | 'chown' | 'chmod' | 'mknod' | 'setxattr'
    | 'getxattr' | 'listxattr' | 'removexattr' | 'open' | 'opendir'
    | 'read' | 'write' | 'release' | 'releasedir' | 'create' | 'unlink'
    | 'rename' | 'link' | 'symlink' | 'mkdir' | 'rmdir' | 'destroy'
    | 'lock' | 'bmap' | 'ioctl' | 'poll' | 'writeBuffer' | 'readBuffer'
    | 'flock' | 'fallocate' | 'copyFileRange' | 'lseek';

  export type Timeouts = {
    default?: number | false;
  } & Partial<Record<OperationName, number | false>>;

  // See https://github.com/refinio/fuse-native
  export interface OPTIONS {
    uid?: number;
    gid?: number;
    timeout?: number | false | Timeouts;
    displayFolder?: boolean;
    debug?: boolean;
    force?: boolean;
    mkdir?: boolean;
    allowOther?: boolean;
    /** Native libfuse spelling for allowOther. */
    allow_other?: boolean;
    allowRoot?: boolean;
    /** Native libfuse spelling for allowRoot. */
    allow_root?: boolean;
    autoUnmount?: boolean;
    /** Native libfuse spelling for autoUnmount. */
    auto_unmount?: boolean;
    defaultPermissions?: boolean;
    /** Native libfuse spelling for defaultPermissions. */
    default_permissions?: boolean;
    blkdev?: boolean;
    blksize?: number;
    /** Unsigned 32-bit maximum passed to both libfuse max_read inputs. */
    maxRead?: number;
    /** Native libfuse spelling for maxRead. */
    max_read?: number;
    /** @deprecated Removed by FUSE 3. Only an explicit false value is accepted. */
    nonEmpty?: false;
    /** @deprecated Historical spelling of the removed FUSE 2 option. */
    nonempty?: false;
    /** @deprecated Managed internally by libfuse3 and rejected at runtime. */
    fd?: never;
    /** @deprecated Managed internally by fusermount3; use uid when appropriate. */
    userId?: never;
    /** @deprecated Native spelling of the internal userId option. */
    user_id?: never;
    fsname?: string;
    subtype?: string;
    kernelCache?: boolean;
    /** Native libfuse spelling for kernelCache. */
    kernel_cache?: boolean;
    autoCache?: boolean;
    /** Native libfuse spelling for autoCache. */
    auto_cache?: boolean;
    /** Enable direct I/O for every opened file through fuse_config. */
    directIo?: boolean;
    /** Historical native spelling for directIo. */
    direct_io?: boolean;
    umask?: number;
    entryTimeout?: number;
    /** Native libfuse spelling for entryTimeout. */
    entry_timeout?: number;
    attrTimeout?: number;
    /** Native libfuse spelling for attrTimeout. */
    attr_timeout?: number;
    acAttrTimeout?: number;
    /** Native libfuse spelling for acAttrTimeout. */
    ac_attr_timeout?: number;
    /** Seconds the kernel caches a failed lookup. 0 turns it off. */
    negativeTimeout?: number;
    /** Native libfuse spelling for negativeTimeout. */
    negative_timeout?: number;
    /** Trust the inode numbers returned by getattr, so hard links match. */
    useIno?: boolean;
    /** Native libfuse spelling for useIno. */
    use_ino?: boolean;
    noforget?: boolean;
    remember?: number;
    modules?: string;
    name?: string;
    onError?: (error: unknown, operation: string, args: readonly unknown[]) => void;
    /** Maximum number of simultaneous native FUSE requests. Range: 1..64. */
    maxConcurrency?: number;
    /** Permit null paths for supported handle-based operations after unlink. */
    nullPathOk?: boolean;
    /** Avoid path reconstruction for supported handle-based operations. */
    noPath?: boolean;
    /** Historical native spelling for noPath. */
    nopath?: boolean;
  }
}

declare class Fuse {
  constructor(mnt: string, ops?: Fuse.OPERATIONS, opts?: Fuse.OPTIONS);

  /** Validate and normalize-check an options object without mounting. */
  static validateOptions(opts?: Fuse.OPTIONS): void;

  /** Verify the complete host FUSE runtime before attempting a mount. */
  static checkEnvironment(opts?: Fuse.OPTIONS): Promise<Fuse.EnvironmentReport>;
  static checkEnvironment(
      opts: Fuse.OPTIONS,
      cb: (err: Error | null, report?: Fuse.EnvironmentReport) => void
  ): void;
  static checkEnvironment(
      cb: (err: Error | null, report?: Fuse.EnvironmentReport) => void
  ): void;

  static unmount(mnt: string, cb?: (err: null | Error) => void): void;

  // Error codes - numeric value retrieved from Fuse instance with errno(code)
  static EPERM: number;
  static ENOENT: number;
  static ESRCH: number;
  static EINTR: number;
  static EIO: number;
  static ENXIO: number;
  static E2BIG: number;
  static ENOEXEC: number;
  static EBADF: number;
  static ECHILD: number;
  static EAGAIN: number;
  static ENOMEM: number;
  static EACCES: number;
  static EFAULT: number;
  static ENOTBLK: number;
  static EBUSY: number;
  static EEXIST: number;
  static EXDEV: number;
  static ENODEV: number;
  static ENOTDIR: number;
  static EISDIR: number;
  static EINVAL: number;
  static ENFILE: number;
  static EMFILE: number;
  static ENOTTY: number;
  static ETXTBSY: number;
  static EFBIG: number;
  static ENOSPC: number;
  static ESPIPE: number;
  static EROFS: number;
  static EMLINK: number;
  static EPIPE: number;
  static EDOM: number;
  static ERANGE: number;
  static EDEADLK: number;
  static ENAMETOOLONG: number;
  static ENOLCK: number;
  static ENOSYS: number;
  static ENOTEMPTY: number;
  static ELOOP: number;
  static EWOULDBLOCK: number;
  static ENOMSG: number;
  static EIDRM: number;
  static ECHRNG: number;
  static EL2NSYNC: number;
  static EL3HLT: number;
  static EL3RST: number;
  static ELNRNG: number;
  static EUNATCH: number;
  static ENOCSI: number;
  static EL2HLT: number;
  static EBADE: number;
  static EBADR: number;
  static EXFULL: number;
  static ENOANO: number;
  static EBADRQC: number;
  static EBADSLT: number;
  static EDEADLOCK: number;
  static EBFONT: number;
  static ENOSTR: number;
  static ENODATA: number;
  static ETIME: number;
  static ENOSR: number;
  static ENONET: number;
  static ENOPKG: number;
  static EREMOTE: number;
  static ENOLINK: number;
  static EADV: number;
  static ESRMNT: number;
  static ECOMM: number;
  static EPROTO: number;
  static EMULTIHOP: number;
  static EDOTDOT: number;
  static EBADMSG: number;
  static EOVERFLOW: number;
  static ENOTUNIQ: number;
  static EBADFD: number;
  static EREMCHG: number;
  static ELIBACC: number;
  static ELIBBAD: number;
  static ELIBSCN: number;
  static ELIBMAX: number;
  static ELIBEXEC: number;
  static EILSEQ: number;
  static ERESTART: number;
  static ESTRPIPE: number;
  static EUSERS: number;
  static ENOTSOCK: number;
  static EDESTADDRREQ: number;
  static EMSGSIZE: number;
  static EPROTOTYPE: number;
  static ENOPROTOOPT: number;
  static EPROTONOSUPPORT: number;
  static ESOCKTNOSUPPORT: number;
  static EOPNOTSUPP: number;
  static ENOTSUP: number;
  static EPFNOSUPPORT: number;
  static EAFNOSUPPORT: number;
  static EADDRINUSE: number;
  static EADDRNOTAVAIL: number;
  static ENETDOWN: number;
  static ENETUNREACH: number;
  static ENETRESET: number;
  static ECONNABORTED: number;
  static ECONNRESET: number;
  static ENOBUFS: number;
  static EISCONN: number;
  static ENOTCONN: number;
  static ESHUTDOWN: number;
  static ETOOMANYREFS: number;
  static ETIMEDOUT: number;
  static ECONNREFUSED: number;
  static EHOSTDOWN: number;
  static EHOSTUNREACH: number;
  static EALREADY: number;
  static EINPROGRESS: number;
  static ESTALE: number;
  static EUCLEAN: number;
  static ENOTNAM: number;
  static ENAVAIL: number;
  static EISNAM: number;
  static EREMOTEIO: number;
  static EDQUOT: number;
  static ENOMEDIUM: number;
  static EMEDIUMTYPE: number;
  static ECANCELED: number;
  static UTIME_NOW: number;
  static UTIME_OMIT: number;

  public readonly opts: Readonly<Fuse.OPTIONS>;
  public readonly mnt: string;
  public readonly ops: Readonly<Fuse.OPERATIONS>;
  public readonly timeout: number | false | Readonly<Fuse.Timeouts>;
  public readonly maxConcurrency: number;

  public mount: (cb: (err?: null | Error) => any) => void;
  public unmount: (cb: (err: null | Error) => any) => void;
  /**
   * Invalidate one cached namespace entry without deleting the underlying file.
   * Must be called outside filesystem operation callbacks.
   * Returns EAGAIN through the callback when the bounded native queue is full.
   */
  public invalidateEntry: (path: string, cb?: (err?: null | Error) => any) => void;

  /**
   * Register an open file descriptor with the kernel for FUSE passthrough,
   * returning a backing id to pass back as `{ fd, backingId }` from open or
   * create. Throws an Error with a `.code` errno name on failure; callers
   * are expected to fall back to ordinary read/write.
   */
  public backingOpen: (fd: number) => number;

  /** Release a backing id, on the last release of the file it belongs to. */
  public backingClose: (backingId: number) => void;

  /** FUSE capability bit for passthrough, for use with `want`. */
  public static CAP_PASSTHROUGH: number;
  public static CAP_ASYNC_READ: number;
  public context: () => Readonly<Fuse.RequestContext> | null;
  public errno: (code?: string) => number;

  // From "nanoresource"
  // See https://github.com/mafintosh/nanoresource/blob/master/index.js
  public opening: boolean;
  public opened: boolean;
  public closing: boolean;
  public closed: boolean;
  public actives: number;

  public open(cb: (err?: Error) => any): void;

  public active(cb?: (err?: Error) => any): boolean;

  public inactive(): void;
  public inactive(cb: (err: Error, val: any) => any, err: null, val: any): void;
  public inactive(cb: (err: Error, val: any) => any, err: Error): void;

  public close(cb?: (err?: Error) => any): void;
  public close(allowActive: boolean, cb: (err?: Error) => any): void;
}

export = Fuse;
