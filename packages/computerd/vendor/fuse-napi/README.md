# fuse-napi

Production-grade Node-API bindings for the FUSE 3 high-level API on Linux and
macOS.

Install the stable package from npm:

```sh
npm install fuse-napi
```

The public API follows semantic versioning. See [CHANGELOG.md](./CHANGELOG.md)
for release notes and migration details.

This project starts from the exact published source of
[`@cocalc/fuse-native@2.4.3`](https://www.npmjs.com/package/@cocalc/fuse-native/v/2.4.3).
It preserves that package's callback-based JavaScript API while using
`FUSE_USE_VERSION=31`. The native addon uses Node-API, with no direct V8 API
dependency.

The addon dynamically links an external FUSE 3 library:

- Linux supports both the long-lived `libfuse3.so.3` ABI and the
  `libfuse3.so.4` ABI introduced by libfuse 3.18.
- macOS uses the `libfuse3` runtime installed by
  [macFUSE](https://macfuse.github.io/).

Neither libfuse nor macFUSE is bundled or installed by this package. See
[UPSTREAM.md](./UPSTREAM.md) for reproducible provenance and
[COMPATIBILITY.md](./COMPATIBILITY.md) for callback and mount-option details.

## Supported targets

| Platform | Minimum runtime | Architectures | Tested Node.js |
| --- | --- | --- | --- |
| Linux | glibc 2.31 and libfuse 3.10.3+ | x86-64, arm64 | 22, 24, 26 |
| Alpine Linux | Alpine 3.23 and libfuse 3.17.3+ (musl) | x86-64, arm64 | 22, 24, 26 |
| macOS | macOS 12 and macFUSE 5.3.1+ with libfuse 3 | Intel x86-64, Apple Silicon arm64 | 22, 24, 26 |

Release prebuilds are compiled on a glibc 2.31 Linux baseline, Alpine 3.23 for
musl, and with `MACOSX_DEPLOYMENT_TARGET=12.0`. Musl binaries carry an explicit
`.musl.node` filename tag and are selected automatically in Alpine containers.
The release workflow rejects binaries that raise a supported baseline
accidentally.

## Requirements

### Linux

Building from source requires a C/C++ toolchain, `pkg-config`, and the system
libfuse 3 development package. Running a prebuild still requires the system
libfuse 3 runtime.

On Debian or Ubuntu:

```sh
sudo apt-get install build-essential fuse3 libfuse3-dev pkg-config
```

On Alpine Linux:

```sh
apk add build-base fuse3 fuse3-dev linux-headers pkgconf python3
```

### macOS

[Install macFUSE](https://github.com/macfuse/macfuse/wiki/Getting-Started)
before installing or loading `fuse-napi`:

```sh
brew install --cask macfuse
```

Approve the macFUSE system extension in System Settings when prompted and
restart macOS if requested. Apple Silicon systems can additionally require
enabling kernel extensions in Startup Security Utility from macOS Recovery.
Installation alone is not sufficient until macFUSE is enabled.

No privileged package configuration command is installed or run. Host FUSE
installation and system-extension approval remain explicit administrator
tasks.

`fuse-napi` requires macFUSE 5.3.1 or newer and verifies the installed product
version before every mount. It uses macFUSE's libfuse 3 compatibility API and
its default VFS backend. The public custom-loop API returns transport-owned buffers, while
current macFUSE releases expose the matching release function only as a
runtime symbol. `fuse-napi` resolves and verifies that capability before every
mount, so an incompatible macFUSE update fails safely with `EMACFUSEABI`.
It does not implement FSKit directly. If the dylib or runtime is unavailable,
installation/loading fails with an actionable macFUSE error.

## Development

```sh
npm ci
npm test
```

`npm test` performs real mount operations and therefore needs `/dev/fuse` plus
mount privileges on Linux, or an installed and approved macFUSE extension on
macOS. `npm run test:unit` runs only the non-mounting dependency, errno,
lifecycle, and option tests. `npm run test:fuzz` deterministically fuzzes the
public validation boundary, and `npm run test:soak` repeatedly mounts,
exercises, and unmounts the filesystem.

Recovery from a deliberately crashed FUSE daemon has a stronger privilege
contract because deterministic cleanup requires `CAP_SYS_ADMIN` on hosted
Linux runners. It is isolated from the ordinary suite and can be run with:

```sh
sudo env "PATH=$PATH" npm run test:privileged-recovery
```

The GitHub `CI` workflow is started manually with `workflow_dispatch`; pushes
and pull requests never trigger it. The manually started release workflow can
reuse the same matrix through `workflow_call`. In addition to the
platform/Node.js matrix, it builds against libfuse 3.18, exercises modern
syscalls, runs static analysis, deterministic fuzzing, ASan/UBSan, and a mount
soak test. The normal Linux matrix exercises the ordinary public API paths as
the unprivileged runner user, then runs the isolated crashed-mount recovery
suite behind an explicit non-interactive root boundary on every supported
OS/Node.js combination. ASan/UBSan covers that privileged recovery path as a
separate command, and the soak gate uses the same deterministic mount
capability boundary. Only the required execution configuration is forwarded
explicitly across each boundary. The libfuse 3.18/SONAME 4 gate exercises its
clean tarball consumer through a dependency-free syscall runner, so
development dependencies cannot mask packaging defects.

The test suite is green on Linux arm64 with libfuse 3.10.3 and on Apple Silicon
with macFUSE 5.3.3. Hosted CI is configured to build both macOS architectures
but cannot load the macFUSE kernel extension. Real macOS mount integration is
therefore a documented manual release check on physical Intel and Apple
Silicon hosts. The automated release workflow performs exact-tarball mounts
and a readlink smoke test on Linux x64/arm64; maintainers repeat the
exact-tarball smoke test manually on both macOS architectures before
publication.

## Migrating from `@cocalc/fuse-native`

Change the package import; existing operation callbacks and mount methods are
retained:

```js
const Fuse = require('fuse-napi')
```

Error constants are negated host errno values. Linux values remain unchanged;
macOS receives the corresponding Darwin values. On macOS, filesystems that
want NFC and NFD names to compare equal must normalize lookup keys themselves.

## API

In order to create a FUSE mountpoint, you first need to create a `Fuse` object that wraps a set of implemented FUSE syscall handlers:

```js
const fuse = new Fuse(mnt, handlers, opts = {})
```

Create a new `Fuse` object.

`mnt` is the string path of your desired mountpoint.

`handlers` is an object mapping syscall names to implementations. The complete list of available syscalls is described below. As an example, if you wanted to implement a filesystem that only supports `getattr`, your handle object would look like:

```js
{
  getattr: function (path, cb) {
    if (path === '/') {
        cb(0, stat({ mode: 'dir', size: 4096 }));
        return;
    }
    if (path === '/test') {
        cb(0, stat({ mode: 'file', size: 11 }));
        return;
    }
    cb(Fuse.ENOENT);
  }
}
```

`opts` can include:

```js
{
  debug: false,        // Enable detailed tracing of operations.
  force: false,        // Recover a disconnected mount before remounting.
  mkdir: false,        // Create the mountpoint before mounting.
  directIo: false,     // Set fuse_config.direct_io for every opened file.
  maxRead: 262144,     // Set max_read and the matching init connection limit.
  timeout: 15000,      // Operation and mount-start timeout in milliseconds.
  maxConcurrency: 4,   // Fixed native request-worker count (1 through 64).
  nullPathOk: false,   // Accept null paths for unlinked handle operations.
  noPath: false,       // Avoid path reconstruction for handle operations.
  onError: (error, operation, args) => {
    // Report exceptions thrown by an operation implementation.
  }
}
```

`force` only detaches a disconnected FUSE mount; it does not replace a healthy
mounted filesystem. Every unmount attempt is followed by a bounded stability
check, so the replacement mount does not race a lazy or concurrent detach. A
non-zero helper result is treated as an idempotent success only when repeated
observations prove that the mount is already detached. If the helper fails and
the mount remains attached, mounting fails with `EFUSEUNMOUNT` while retaining
both the helper and observation errors. A successful helper whose detach is
still not stably observable after 15 seconds fails with `EFUSEUNMOUNTWAIT`.
Unmount helpers inherit ordinary process settings such as `PATH`, but dynamic
loader injection variables (`LD_*` and `DYLD_*`) are removed before executing
the system helper. This keeps sanitizer, instrumentation, and application
preloads from changing the privileged unmount boundary. Helper standard output
and error output are retained on `helperError` when unmounting fails.

On macOS, volume presentation can additionally be configured with:

```js
{
  displayFolder: true,
  name: 'Folder Name'
}
```

`timeout` can also be an object such as
`{ default: 15000, read: 30000, init: 5000 }`. Set an individual value or
`default` to `false` to disable that timeout deliberately.

Each operation callback is accepted only once. A timeout, synchronous
exception, or rejected promise is translated to a FUSE error and cannot leave
the native worker blocked. Return values, buffer lengths, directory entries,
extended attributes, statistics, and mount options are validated before they
cross the native boundary. Unknown option and operation names are rejected so
configuration mistakes cannot silently change filesystem behavior.

`Fuse.validateOptions(options)` performs the same synchronous validation
without creating a filesystem instance. Invalid combinations throw a
`TypeError` with a stable `code` and an `options` array. The FUSE 3 preflight
rejects removed or internal options (`nonempty`, `fd`, and `user_id`),
platform-specific misuse, unsafe module identifiers, and conflicting cache,
access, block-device, or inode-retention policies. For example:

```js
Fuse.validateOptions({
  directIo: true,
  nonempty: true
})
// TypeError with code ERR_FUSE_OPTION_REMOVED
```

Remove `nonempty`; use `directIo` as shown when direct I/O is required. See
the 2.0.0 section in [CHANGELOG.md](./CHANGELOG.md) when upgrading from the
1.x line.

For mount options with a native snake-case spelling, both the JavaScript name
and the historical libfuse name are accepted when the underlying FUSE 3
concept still exists (for example, `directIo`/`direct_io` and
`allowOther`/`allow_other`). Inputs are normalized to the JavaScript name, and
conflicting aliases are rejected.

`await Fuse.checkEnvironment(options)` performs the production runtime
preflight without mounting. It verifies the loaded libfuse version and
capabilities and, on Linux, `fusermount3`, read/write access to `/dev/fuse`,
and `user_allow_other` when `allowOther` or `allowRoot` is requested. Mounting
performs this check automatically. Failures have stable codes such as
`EFUSEHELPER`, `EFUSEDEVICE`, `EFUSEALLOWOTHER`, `EFUSEVERSION`, and
`EMACFUSEVERSION`, and `EMACFUSEABI`. On macOS the preflight reads the installed
macFUSE product version and rejects mounts below 5.3.1.

The native request loop uses exactly `maxConcurrency` workers instead of
libfuse's dynamically growing multithreaded loop. This bounds native
threads, outstanding JavaScript callbacks, and memory use under load. Mount
startup runs outside the JavaScript event loop and remains subject to the
configured `init` deadline.

### Namespace cache housekeeping

Every distinct path resolved by the kernel creates a reachable high-level
libfuse node until the kernel sends `FORGET`. `release` closes a file handle;
it does not evict that namespace entry. Filesystems that expose a continuous
stream of one-shot names can ask the kernel to drop an inactive entry without
deleting the underlying file:

```js
fuse.invalidateEntry('/archive/file-123', err => {
  if (err) console.error(err)
})
```

Call `invalidateEntry` only after the client-side `close()` has returned, or
from an independent housekeeping timer. Notifications run serially on a
bounded, dedicated native worker, so a kernel reverse-invalidation lock cannot
block the JavaScript event loop or exhaust libuv's shared worker pool. Never
call it from `getattr`, `open`, `release`, or another filesystem operation callback;
the method rejects operation-local calls with `EDEADLK` because Linux reverse
invalidation can otherwise deadlock with the originating request. The method
accepts nested paths, resolves the parent node, and sends portable
`FUSE_NOTIFY_INVAL_ENTRY`. macOS mounts require macFUSE 5.3.1+, whose VFS
backend actually evicts the notified name-cache entry. The method returns
`ENOSYS` if the connected kernel does not support the notification. At most
1,024 notifications wait per mount; a larger concurrent burst returns `EAGAIN`
instead of growing native memory without bound. A later access performs a fresh
lookup, so choose a retention window that balances memory against metadata traffic.

For a larger usage example, see CoCalc's
[WebSocketFS FUSE integration](https://github.com/sagemathinc/websocketfs/tree/main/lib/fuse).

### FUSE API

The portable callback surface from 1.x remains supported on FUSE 3.
Deprecated `getdir` and `utime` are represented by `readdir` and `utimens`.
FUSE 3's merged `getattr`/`fgetattr` and `truncate`/`ftruncate` operations are
routed to the existing handlers based on whether a file handle is present. In
general the callback for each op should be called with
`cb(returnCode, [value])`, where the return code is a number (`0` for OK and
`< 0` for errors). See below for a list of POSIX error codes.

File handles, file positions, sizes, inode counters, and other 64-bit values
are passed as a `number` while exactly representable and as a `bigint`
otherwise. Implementations must preserve a `bigint` file handle and return it
unchanged to their own storage layer.

During an operation, `fuse.context()` returns a frozen snapshot containing
`uid`, `gid`, `pid`, `umask`, and the portable `fuse_file_info` fields. The
context is isolated across promises and other asynchronous work with
`AsyncLocalStorage`; outside an operation it returns `null`. When
`nullPathOk` or `noPath` is enabled, the affected handle-based callbacks must
accept `null` as their path. On Linux, `pid` identifies the calling thread and
can differ from `process.pid` when Node.js performs filesystem I/O in its
libuv worker pool.

TypeScript: see [index.d.ts](./index.d.ts).

#### `ops.init(cb)`

Called on filesystem init.

#### `ops.initWithConfig(connection, cb)`

Enhanced, mutually exclusive alternative to `init`. `connection` is a frozen
snapshot of the portable FUSE 3 connection fields:
`protoMajor`, `protoMinor`, `asyncRead`, `maxWrite`, `maxReadahead`,
`maxRead`, `capable`, `want`, `maxBackground`, and `congestionThreshold`.

The callback may return a conservative configuration containing `maxWrite`,
`maxReadahead`, `maxBackground`, `congestionThreshold`, `want`, and/or
`asyncRead`.
Requested limits may not exceed the values supplied by the kernel, `want`
must be a subset of `capable`, and the congestion threshold may not exceed
the background-request limit. Omitting the configuration preserves all
libfuse defaults.

Set `maxRead` through the constructor options. When present, fuse-napi passes
the same validated unsigned 32-bit value as both `max_read=<n>` and
`connection.maxRead`; this is required by libfuse 3. It is intentionally not
an `initWithConfig` result field because changing it after the mount options
have been processed would make the two libfuse values inconsistent. When the
option is omitted, fuse-napi leaves `conn->max_read` to libfuse and kernel
negotiation. The kernel may enforce a lower effective request size.

#### `ops.access(path, mode, cb)`

Called before the filesystem accessed a file

#### `ops.statfs(path, cb)`

Called when the filesystem is being stat'ed. Accepts a fs stat object after the return code in the callback.

``` js
ops.statfs = function (path, cb) {
  cb(0, {
    bsize: 1000000,
    frsize: 1000000,
    blocks: 1000000,
    bfree: 1000000,
    bavail: 1000000,
    files: 1000000,
    ffree: 1000000,
    favail: 1000000,
    fsid: 1000000,
    flag: 1000000,
    namemax: 1000000
  })
}
```

#### `ops.getattr(path, cb)`

Called when a path is being stat'ed. Accepts a stat object (similar to the one returned in `fs.stat(path, cb)`) after the return code in the callback.

``` js
ops.getattr = function (path, cb) {
  cb(0, {
    mtime: new Date(),
    atime: new Date(),
    ctime: new Date(),
    size: 100,
    mode: 16877,
    uid: process.getuid(),
    gid: process.getgid()
  })
}
```

#### `ops.fgetattr(path, fd, cb)`

Same as above but is called when someone stats a file descriptor

#### `ops.flush(path, fd, cb)`

Called when a file descriptor is being flushed

#### `ops.fsync(path, datasync, fd, cb)`

Called when a file descriptor is being fsync'ed.

#### `ops.fsyncdir(path, datasync, fd, cb)`

Same as above but on a directory

#### `ops.readdir(path, cb)`

Called when a directory is being listed. Accepts an array of file/directory names after the return code in the callback

``` js
ops.readdir = function (path, cb) {
  cb(0, ['file-1.txt', 'dir'])
}
```

#### `ops.readdirPaged(path, fd, offset, cb)`

Enhanced, mutually exclusive alternative to `readdir` for large or remote
directories. `fd` is the handle returned by `opendir`; `offset` is an opaque
signed 64-bit resume value. Return
`cb(0, names, stats, nextOffsets)`, where every name has a corresponding
non-zero next offset. The kernel can resume at the last accepted offset when
its output buffer is full.

#### `ops.truncate(path, size, cb)`

Called when a path is being truncated to a specific size

#### `ops.ftruncate(path, fd, size, cb)`

Same as above but on a file descriptor

#### `ops.readlink(path, cb)`

Called when a symlink is being resolved. Accepts a pathname (that the link should resolve to) after the return code in the callback

``` js
ops.readlink = function (path, cb) {
  cb(null, 'file.txt') // make link point to file.txt
}
```

Targets longer than the kernel-provided buffer are truncated and
NUL-terminated as required by the FUSE high-level callback contract.

#### `ops.chown(path, uid, gid, cb)`

Called when ownership of a path is being changed

#### `ops.chmod(path:string, mode:number, cb)`

Called when the mode of a path is being changed.  Always called
with mode a number (not a string).

#### `ops.mknod(path, mode, dev, cb)`

Called when a new device file is being made.

#### `ops.setxattr(path, name, value, position, flags, cb)`

Called when extended attributes is being set (see the extended docs for your platform).

`value` is a request-owned copy and can safely be consumed asynchronously.
Copy it only when your storage layer requires independent mutability or
lifetime management.

The position argument is mostly a legacy argument only used on MacOS but see the getxattr docs
on Mac for more on that (you probably don't need to use that).

#### `ops.getxattr(path, name, position, cb)`

Called when extended attributes is being read.

Return the extended attribute as the second argument to the callback (needs to be a buffer).
If no attribute is stored return `null` as the second argument.

The position argument is mostly a legacy argument only used on MacOS but see the getxattr docs
on Mac for more on that (you probably don't need to use that).

#### `ops.listxattr(path, cb)`

Called when extended attributes of a path are being listed.

Return a list of strings of the names of the attributes you have stored as the second argument to the callback.

#### `ops.removexattr(path, name, cb)`

Called when an extended attribute is being removed.

#### `ops.open(path, flags, cb)`

Called when a path is being opened. `flags` in a number containing the permissions being requested. Accepts a file descriptor after the return code in the callback.

``` js
var toFlag = function(flags) {
  flags = flags & 3
  if (flags === 0) return 'r'
  if (flags === 1) return 'w'
  return 'r+'
}

ops.open = function (path, flags, cb) {
  var flag = toFlag(flags) // convert flags to a node style string
  ...
  cb(0, 42) // 42 is a file descriptor
}
```

The callback may alternatively return
`{ fd, directIO, keepCache, nonseekable }`. This sets the corresponding
portable `fuse_file_info` result bits while retaining primitive file-handle
results for compatibility. `opendir` and both create variants accept the
same result object.

#### `ops.opendir(path, flags, cb)`

Same as above but for directories

#### `ops.read(path, fd, buffer, length, position, cb)`

Called when contents of a file is being read. You should write the result of the read to the `buffer` and return the number of bytes written as the first argument in the callback.
If no bytes were written (read is complete) return 0 in the callback.

The buffer is owned by the JavaScript request. It remains valid if an
operation times out or teardown starts; completed bytes are copied back to
the kernel only after the callback result has been validated.

``` js
var data = Buffer.from('hello world')

ops.read = function (path, fd, buffer, length, position, cb) {
  if (position >= data.length) return cb(0) // done
  var part = data.slice(position, position + length)
  part.copy(buffer) // write the result of the read to the result buffer
  cb(part.length) // return the number of bytes read
}
```

#### `ops.write(path, fd, buffer, length, position, cb)`

Called when a file is being written to. You can get the data being written in `buffer` and you should return the number of bytes written in the callback as the first argument.

The write buffer is a request-owned copy, so asynchronous consumers never
reference kernel request memory after a timeout.

``` js
ops.write = function (path, fd, buffer, length, position, cb) {
  console.log('writing', buffer.slice(0, length))
  cb(length) // we handled all the data
}
```

#### `ops.release(path, fd, cb)`

Called when a file descriptor is being released. Happens when a read/write is done etc.

#### `ops.releasedir(path, fd, cb)`

Same as above but for directories

#### `ops.create(path, mode, cb)`

Called when a new file is being opened.

#### `ops.createWithFlags(path, mode, flags, cb)`

Enhanced, mutually exclusive alternative to `create`. It also receives the
original FUSE/POSIX open flags. Its callback accepts either a primitive file
handle or the file-info result object described under `open`.

#### `ops.utimens(path, atime, mtime, cb)`

Called when the atime/mtime of a file is being changed. `atime` and `mtime`
are signed integer milliseconds since the Unix epoch and can be `bigint`
outside JavaScript's safe-integer range.

#### `ops.utimensWithTimespec(path, atime, mtime, cb)`

Mutually exclusive, lossless alternative to `utimens`. Both times are frozen
`{ seconds, nanoseconds }` values. Nanoseconds are preserved exactly and may
be `Fuse.UTIME_NOW` or `Fuse.UTIME_OMIT`; the native
`flag_utime_omit_ok` bit is enabled only for this variant. Stat timestamps may
also be returned in this timespec form.

#### `ops.utimensWithHandle(path, fd, atime, mtime, cb)`

Handle-aware alternative to both `utimens` variants. It receives a nullable
path, the open file handle, and the same lossless timespec values as
`utimensWithTimespec`. Use this variant when `nullPathOk` is enabled.

#### `ops.chownWithHandle(path, fd, uid, gid, cb)`

Handle-aware alternative to `chown`. The path can be `null` when
`nullPathOk` is enabled.

#### `ops.chmodWithHandle(path, fd, mode, cb)`

Handle-aware alternative to `chmod`. The path can be `null` when
`nullPathOk` is enabled.

#### `ops.destroy(cb)`

Called exactly once when an initialized filesystem exits through an orderly
libfuse teardown. Teardown waits for this callback, subject to the configured
operation deadline. JavaScript cannot be called once the Node-API environment
itself is already shutting down.

#### `ops.lock(path, fd, command, lock, cb)`

Handles portable POSIX record locks. `lock` is a frozen object with `type`,
`whence`, signed `start`, signed `length`, and `pid`. For `F_GETLK`, return an
updated lock as the second callback argument.

#### `ops.flock(path, fd, operation, cb)`

Handles BSD `flock` operations for filesystems that need remote locking.
Without this callback the kernel can still provide local locking.

#### `ops.bmap(path, blockSize, index, cb)`

Maps a file block to a device block. Return the mapped 64-bit index as the
second callback argument. This is meaningful for block-device-backed mounts.

#### `ops.ioctl(path, fd, command, argument, flags, data, cb)`

Handles bounded, well-formed FUSE ioctls. `argument` and file handles remain
lossless, and `data` is request-owned. Return a same-length output Buffer.
Unrestricted retry/iovec ioctls are rejected with `EOPNOTSUPP` because their
borrowed-pointer protocol cannot be represented safely by this callback API.
Payloads larger than 1 MiB are rejected before entering JavaScript.

#### `ops.poll(path, fd, cb)`

Returns a snapshot readiness event mask.

#### `ops.pollWithHandle(path, fd, handle, cb)`

Mutually exclusive, notification-capable alternative to `poll`. Return the
initial readiness mask through `cb`. When `handle` is non-null, call
`handle.notify()` after readiness changes so the kernel re-evaluates the
poll, then call `handle.close()` when no further notification is needed.
Handles are idempotent and are closed automatically during teardown.

#### `ops.writeBuffer(path, fd, buffer, length, position, cb)`

Mutually exclusive alternative to `write` implementing FUSE `write_buf`.
Generic memory/file-descriptor vectors are flattened into a request-owned
Buffer before JavaScript is called. Return the validated byte count.

#### `ops.readBuffer(path, fd, length, position, cb)`

Mutually exclusive alternative to `read` implementing FUSE `read_buf`.
Return `cb(0, buffer)` with at most `length` bytes; native storage is allocated
with the ownership rules required by libfuse.

#### `ops.fallocate(path, fd, mode, offset, length, cb)`

Allocates a signed 64-bit byte range for an open file.

#### `ops.copyFileRange(src, srcFd, srcOffset, dest, destFd, destOffset, length, flags, cb)`

Implements FUSE 3 `copy_file_range`. Return the copied byte count directly to
`cb`; negative values are treated as errno results. Paths can be `null` for
handle-based requests, and all offsets and handles retain 64-bit precision.

#### `ops.lseek(path, fd, offset, whence, cb)`

Implements FUSE 3 `lseek`, including `SEEK_DATA` and `SEEK_HOLE`. Return
`cb(0, resultingOffset)`.

#### `ops.unlink(path, cb)`

Called when a file is being unlinked.

#### `ops.rename(src, dest, cb)`

Called for an unflagged rename. A flagged request is rejected with
`EOPNOTSUPP` rather than silently losing its semantics.

#### `ops.renameWithFlags(src, dest, flags, cb)`

Mutually exclusive alternative to `rename` that receives the native FUSE 3
rename flags, including Linux `RENAME_NOREPLACE`.

#### `ops.link(src, dest, cb)`

Called when a new link is created.

#### `ops.symlink(src, dest, cb)`

Called when a new symlink is created

#### `ops.mkdir(path, mode, cb)`

Called when a new directory is being created

#### `ops.rmdir(path, cb)`

Called when a directory is being removed

## License

MIT for these bindings.

The bindings retain their upstream MIT license and attribution. The external
[libfuse](https://github.com/libfuse/libfuse) and
[macFUSE](https://github.com/macfuse/macfuse) installations retain their own
licenses.

Security issues should be reported privately according to
[SECURITY.md](./SECURITY.md). Maintainer release procedures are documented in
[RELEASING.md](./RELEASING.md). Contributions are accepted through pull
requests under the maintainer-controlled process in
[CONTRIBUTING.md](./CONTRIBUTING.md).
