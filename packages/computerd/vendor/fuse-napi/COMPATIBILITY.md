# FUSE 3 compatibility matrix

This document describes the current `fuse-napi` contract inherited from
`@cocalc/fuse-native@2.4.3`, including its FUSE 3 portability and
production-hardening guarantees.

## Callback matrix

All listed callbacks use the existing asynchronous JavaScript callback style.
The native layer targets the FUSE 3.1 high-level API
(`FUSE_USE_VERSION=31`) while retaining the callback contract from 1.x.

| JavaScript callback | Linux libfuse 3 | macFUSE libfuse 3 | Current status and differences |
| --- | --- | --- | --- |
| `init(cb)` / `initWithConfig(connection, cb)` | Yes | Yes | Legacy defaults remain unchanged. The enhanced variant exposes and validates the portable FUSE 3 connection fields, including the active `maxRead`, before applying conservative limits/capabilities. Public mount completion waits until the mounted device is visible. |
| `access(path, mode, cb)` | Yes | Yes | Shared implementation. Suppressed by `default_permissions`. |
| `statfs(path, cb)` | Yes | Yes | Shared `struct statvfs` implementation with range-checked 64-bit fields. macFUSE also offers unsupported `statfs_x`. |
| `getattr(path, cb)` | Yes | Yes | Shared, zero-initialized implementation with range-checked 64-bit fields and platform-specific timestamp members. A null path is routed to `fgetattr`. |
| `fgetattr(path, fd, cb)` | Yes | Yes | Handle-aware implementation; path can be null with `nullPathOk`. |
| `flush(path, fd, cb)` | Yes | Yes | Shared implementation. May be called more than once per open. |
| `fsync(path, datasync, fd, cb)` | Yes | Yes | Shared implementation. |
| `fsyncdir(path, datasync, fd, cb)` | Yes | Yes | Shared implementation. |
| `readdir(path, cb)` / `readdirPaged(path, fd, offset, cb)` | Yes | Yes | Legacy mode returns one array with zero filler offsets. The mutually exclusive paged variant forwards the directory handle and signed 64-bit offset and requires one non-zero resume offset per entry. |
| `truncate(path, size, cb)` | Yes | Yes | Signed 64-bit transport; values outside the safe-number range are delivered as `bigint`. |
| `ftruncate(path, fd, size, cb)` | Yes | Yes | Signed 64-bit transport; values outside the safe-number range are delivered as `bigint`. |
| `utimens(path, atime, mtime, cb)` / `utimensWithTimespec(path, atime, mtime, cb)` / `utimensWithHandle(path, fd, atime, mtime, cb)` | Yes | Yes | The legacy variant transports signed milliseconds. Enhanced variants preserve seconds and nanoseconds exactly and safely enable `UTIME_NOW`/`UTIME_OMIT`; the handle-aware variant supports null paths. |
| `readlink(path, cb)` | Yes | Yes | Shared implementation; oversized targets are safely truncated and NUL-terminated to the caller-provided buffer. |
| `chown(path, uid, gid, cb)` / `chownWithHandle(path, fd, uid, gid, cb)` | Yes | Yes | The enhanced variant receives the FUSE 3 file handle and supports null paths. |
| `chmod(path, mode, cb)` / `chmodWithHandle(path, fd, mode, cb)` | Yes | Yes | The enhanced variant receives the FUSE 3 file handle and supports null paths. |
| `mknod(path, mode, dev, cb)` | Yes | Yes | Shared implementation; useful node types vary by host policy. |
| `setxattr(path, name, value, position, flags, cb)` | Yes | Yes | macOS native signature includes `position`; Linux supplies position `0`. JavaScript receives a request-owned copy rather than borrowed kernel memory. |
| `getxattr(path, name, position, cb)` | Yes | Yes | Callback returns a `Buffer`; validated bytes are copied into the native request only on completion. Round trips, listing, removal, and resource forks are covered. |
| `listxattr(path, cb)` | Yes | Yes | Uses an exact UTF-8/NUL size probe, request-owned output storage, and returns `ERANGE` when the caller buffer is too small. |
| `removexattr(path, name, cb)` | Yes | Yes | Shared implementation. |
| `open(path, flags, cb)` | Yes | Yes | Shared implementation; primitive handles remain compatible and `{ fd, directIO, keepCache, nonseekable }` can set portable result bits. |
| `opendir(path, flags, cb)` | Yes | Yes | Forwards open flags and accepts the same validated file-info result as `open`. |
| `read(path, fd, buffer, length, position, cb)` | Yes | Yes | Signed 64-bit positions and lossless handles; uses owned output memory and copies only a validated byte count to FUSE. |
| `write(path, fd, buffer, length, position, cb)` | Yes | Yes | Signed 64-bit positions and lossless handles; JavaScript receives an owned copy of the native request bytes. |
| `release(path, fd, cb)` | Yes | Yes | Shared implementation; return value is ignored by FUSE. |
| `releasedir(path, fd, cb)` | Yes | Yes | Shared implementation. |
| `create(path, mode, cb)` / `createWithFlags(path, mode, flags, cb)` | Yes | Yes | Legacy mode is unchanged. The mutually exclusive enhanced variant also receives the original open flags; both accept enriched file-info results. |
| `unlink(path, cb)` | Yes | Yes | Shared implementation; deletion while an open handle survives is covered on macOS. |
| `rename(src, dest, cb)` / `renameWithFlags(src, dest, flags, cb)` | Yes | Yes | The legacy callback accepts unflagged renames only. The enhanced variant preserves FUSE 3 rename flags instead of silently discarding them. |
| `link(src, dest, cb)` | Yes | Yes | Shared implementation. |
| `symlink(src, dest, cb)` | Yes | Yes | Shared implementation. |
| `mkdir(path, mode, cb)` | Yes | Yes | Shared implementation. |
| `rmdir(path, cb)` | Yes | Yes | Shared implementation. |
| `destroy(cb)` | Yes | Yes | Called once after an orderly exit of an initialized filesystem. Native cleanup waits for completion before releasing the environment and libfuse resources. |
| `lock(path, fd, command, lock, cb)` | Yes | Yes | Portable POSIX record-lock fields are transported losslessly; `F_GETLK` may return an updated lock. |
| `flock(path, fd, operation, cb)` | Yes | Yes | Shared BSD whole-file locking implementation. |
| `bmap(path, blockSize, index, cb)` | Yes | Yes | Lossless block-index transport for block-device-backed filesystems. |
| `ioctl(path, fd, command, argument, flags, data, cb)` | Yes | Yes | Bounded request-owned payloads up to 1 MiB. Unsafe unrestricted retry/iovec requests return `EOPNOTSUPP`. |
| `poll(path, fd, cb)` / `pollWithHandle(path, fd, handle, cb)` | Yes | Yes | Legacy mode returns snapshot readiness. The enhanced variant safely retains an idempotent notification handle, supports delayed `notify()`, and closes every native handle during explicit close, finalization, or teardown. |
| `writeBuffer(path, fd, buffer, length, position, cb)` | Yes | Yes | Implements `write_buf`; generic vectors are flattened into request-owned bytes before JavaScript runs. Mutually exclusive with `write`. |
| `readBuffer(path, fd, length, position, cb)` | Yes | Yes | Implements `read_buf` with libfuse-compatible native ownership. Mutually exclusive with `read`. |
| `fallocate(path, fd, mode, offset, length, cb)` | Yes | Yes | Shared implementation with signed, lossless 64-bit range transport. |
| `copyFileRange(src, srcFd, srcOffset, dest, destFd, destOffset, length, flags, cb)` | Yes | Yes | FUSE 3 range copy with nullable paths and lossless handles/offsets. Result length is range-checked. |
| `lseek(path, fd, offset, whence, cb)` | Yes | Yes | FUSE 3 seek with lossless offsets, including `SEEK_DATA` and `SEEK_HOLE`. |
| Linux `statx` | Yes | Kernel fallback | Native high-level callback is compiled for libfuse 3.18+/SONAME 4; older Linux runtimes use the kernel's `getattr` fallback. |

### Deprecated FUSE callbacks

The portable callback contract from 1.x remains exposed. The two superseded
callbacks are intentionally represented by their modern equivalents:

| Callback | Status | Decision |
| --- | --- | --- |
| `getdir`, `utime` | Deprecated | Do not add; use `readdir` and `utimens`. |

### macFUSE-only callbacks not exposed

macFUSE appends optional Darwin extensions to `struct fuse_operations`.
They are deliberately outside the portable callback scope:

| Callback | Typical purpose | Initial-release decision |
| --- | --- | --- |
| `monitor` | Finder/file watcher count changes | Defer; macFUSE-specific. |
| `renamex` | Legacy macOS extension flags | Portable FUSE 3 flags use `renameWithFlags`; the separate legacy extension is not registered. |
| Darwin `statfs` ABI | Darwin `struct statfs` | Adapted to the portable JavaScript `statfs` result. |
| `setvolname` | Change volume name | Use the `volname` mount option. |
| `exchange` | Exchange two paths | Defer; unsupported on recent macOS versions. |
| `getxtimes`, `setbkuptime`, `setchgtime`, `setcrtime` | macOS extended timestamps | Defer; test portable timestamps first. |
| `chflags` | BSD file flags | Defer. |
| Compound Darwin `setattr` | Metadata updates | Adapted in a stable chmod/chown/truncate/utimens sequence. |

## Mount-option matrix

Every option is validated against the supported FUSE 3 contract before
`_fuseOptions()` serializes it. The constructor and `Fuse.validateOptions()`
reject unsupported, internal, platform-specific, conflicting, or incomplete
configurations before libfuse is invoked.

| JavaScript option | Serialized option/behavior | Linux | macFUSE VFS | Notes |
| --- | --- | --- | --- | --- |
| `debug` | `debug` | Yes | Yes | Also enabled by the inherited `DEBUG` environment check. |
| `allowOther` | `allow_other` | Yes | Yes | Security-sensitive; Linux may require `user_allow_other`. Mutually exclusive with `allowRoot`. |
| `allowRoot` | `allow_root` | Yes | Yes | Mutually exclusive with `allowOther`. |
| `autoUnmount` | `auto_unmount` | Yes | Yes | Requires crash/interruption tests. |
| `defaultPermissions` | `default_permissions` | Yes | Yes | Boolean in both runtime and TypeScript declarations. |
| `blkdev` | `blkdev` | Yes | Rejected | Linux-only, privileged, and requires `fsname`. |
| `blksize` | `blksize=<n>` | Yes | Rejected | Linux-only and requires `blkdev: true`. |
| `maxRead` | `max_read=<n>` and matching `conn->max_read` | Yes | Yes | Both libfuse inputs receive the exact validated `uint32_t` value, including zero. When omitted, neither is set by fuse-napi. Configure it only as a constructor option; the kernel may enforce a lower request limit. |
| `fd` | Rejected | Internal | Internal | libfuse3 owns the FUSE device descriptor. |
| `userId` | Rejected | Internal | Internal | `fusermount3` owns `user_id`; use `uid` only to override returned ownership. |
| `fsname` | `fsname=<name>` | Yes | Yes | Finder presentation also depends on `volname`. |
| `subtype` | `subtype=<name>` | Yes | Yes | Reflected in platform mount information. |
| `kernelCache` | `kernel_cache` | Yes | Yes | Cannot be combined with `autoCache` or `directIo`. |
| `autoCache` | `auto_cache` | Yes | Yes | Cannot be combined with `kernelCache` or `directIo`. |
| `directIo` | `fuse_config.direct_io` | Yes | Yes | Cannot be combined with page-cache policies. This is separate from returning `directIO` for one `open` or `create` result. |
| `umask` | `umask=<mask>` | Yes | Yes | Explicit zero is preserved; chmod behavior is covered. |
| `uid` | `uid=<n>` | Yes | Yes | Explicit zero is preserved; ownership behavior is covered. |
| `gid` | `gid=<n>` | Yes | Yes | Explicit zero is preserved; ownership behavior is covered. |
| `entryTimeout` | `entry_timeout=<s>` | Yes | Yes | Controls lookup caching. |
| `attrTimeout` | `attr_timeout=<s>` | Yes | Yes | Controls attribute caching. |
| `acAttrTimeout` | `ac_attr_timeout=<s>` | Yes | Yes | Requires `autoCache: true`. |
| `noforget` | `noforget` | Yes | Yes | Mutually exclusive with `remember`; high memory-retention risk. |
| `nonEmpty` | Rejected when enabled | Removed | Removed | FUSE 3 permits non-empty mountpoints without this FUSE 2 option. |
| `remember` | `remember=<s>` | Yes | Yes | Mutually exclusive with `noforget`. |
| `modules` | `modules=<list>` | Yes | Yes | Colon-separated module identifiers are validated; modules must still be installed. |
| `displayFolder` | `volname`, optionally `volicon` | Rejected | Yes | Uses `name` or mount basename; macFUSE-only. |
| `force` | Disconnected-mount recovery | Yes | Yes | JavaScript lifecycle option, not a FUSE mount option. Healthy mounts are preserved; lazy detach completion is verified with a finite deadline. |
| `mkdir` | Create missing mount point | Yes | Yes | JavaScript lifecycle option. |
| `timeout` | JavaScript callback timeout | Yes | Yes | Bounds callbacks and mount startup; per-operation `false` and zero values are preserved. |
| `name` | Source for `volname` | Rejected | Yes | Requires `displayFolder: true`. |
| `onError` | JavaScript exception reporter | Yes | Yes | Receives operation exceptions and rejected promises before the request is completed with `EIO`. |
| `maxConcurrency` | Fixed native request-worker count | Yes | Yes | Integer from 1 through 64; defaults to 4 and bounds threads, outstanding callbacks, and request memory. |
| `nullPathOk` | `fuse_config.nullpath_ok` | Yes | Yes | Allows `null` paths only when every configured affected operation has its handle-aware counterpart; invalid combinations are rejected in the constructor. |
| `noPath` | `fuse_config.nullpath_ok` compatibility mapping | Yes | Yes | Retains the 1.x behavior and enforces the same handle-aware callback requirements as `nullPathOk`. |

`fuse.invalidateEntry(path, cb)` uses the portable FUSE notification protocol
to evict one cached namespace entry without unlinking it. It supports nested
paths on Linux, must run outside filesystem operation callbacks, and reports
`ENOSYS` when the connected kernel lacks entry-invalidation support.

Historical native libfuse spellings are normalized before validation:
`allow_other`, `allow_root`, `auto_unmount`, `default_permissions`,
`max_read`, `user_id`, `kernel_cache`, `auto_cache`, `direct_io`,
`entry_timeout`, `attr_timeout`, `ac_attr_timeout`, `nonempty`, and `nopath`.
Removed or internal spellings therefore receive the same actionable FUSE 3
error as their JavaScript equivalent. Supplying both forms with different
values is an error.

String-valued mount options reject NUL, comma, backslash, and newline
characters instead of allowing one JavaScript value to inject additional
libfuse options. Numeric options must be finite and within their declared
integer constraints.

Conformance failures are `TypeError` instances with one of these stable codes:
`ERR_FUSE_OPTION_REMOVED`, `ERR_FUSE_OPTION_INTERNAL`,
`ERR_FUSE_OPTION_CONFLICT`, `ERR_FUSE_OPTION_DEPENDENCY`,
`ERR_FUSE_OPTION_PLATFORM`, or `ERR_FUSE_OPTION_VALUE`. Their frozen
`options` array identifies the relevant canonical JavaScript option names.

### macFUSE backend options

The supported macFUSE 5.3.1+ runtime defaults to its VFS/kernel-extension
backend. Its public libfuse API also accepts `backend=fskit` on supported macOS
versions. `fuse-napi` does not
currently expose a dedicated backend option.

The current implementation targets the VFS backend because it preserves the broadest
FUSE behavior and accepts the inherited temporary mount points. Selecting
FSKit later through macFUSE's public libfuse API would still avoid a direct
FSKit implementation, but must be explicitly scoped and tested because
macFUSE documents these current differences:

- mount points must be under `/Volumes`;
- FUSE context is unavailable;
- most kernel-handled mount options are not implemented;
- notification APIs are unavailable; and
- performance is lower than the VFS backend.

## Runtime compatibility

Linux release packages contain ABI-specific Node.js 22/24/26 binaries for
both libfuse SONAME 3 and SONAME 4. The loader prefers a local source build,
then selects the modern SONAME 4 artifact when the runtime supports it, and
falls back to SONAME 3. Missing shared libraries produce `EFUSEDEPENDENCY`
with installation guidance.

Every mount performs a runtime preflight. Linux checks `fusermount3`,
`/dev/fuse`, the loaded libfuse version, and `fuse.conf` policy when required.
macOS checks the macFUSE installation and the buffer-release capability used
by its custom event loop. libfuse 3.10.3 is the supported minimum.

## Errno compatibility

Callbacks return negated host errno values. The exported constants are
initialized with the inherited Linux values and then replaced by matching
values from the host's `os.constants.errno` where available. Linux therefore
retains its existing numbers while Darwin receives macOS values such as
`ENOSYS=-78`, `ENOTSUP=-45`, and `ETIMEDOUT=-60`.

Linux-only constants that have no host equivalent remain available for API
compatibility. Applications should return the portable constant matching the
operation; `ENOTSUP` is explicitly exported for macOS extended-attribute
behavior.
