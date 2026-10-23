# Vendored `fuse-napi`

Upstream: [`fuse-napi`](https://www.npmjs.com/package/fuse-napi) **2.3.1**, MIT.
See `LICENSE` (retained unmodified) and `UPSTREAM.md` for the upstream's own
provenance notes.

Vendored rather than depended on because the changes below are not upstream.

## Why

`fuse-native` links libfuse 2.9, which cannot negotiate `FOPEN_PASSTHROUGH`.
`fuse-napi` is a maintained fork of the same line built against libfuse 3, so
it is a much shorter path to passthrough than patching libfuse 2.

## What we changed

The passthrough changes live in `fuse-native.c`, `index.js`, and `index.d.ts`.
Native roots also add `removal-guard.c`, `removal-guard.h`, and
`confined-bind.c`, linked through `binding.gyp`.

### `fuse-native.c`

- Include `<fuse_lowlevel.h>`, `<sys/ioctl.h>` and `<linux/fuse.h>`, with
  fallback definitions of `FUSE_DEV_IOC_BACKING_OPEN` /
  `FUSE_DEV_IOC_BACKING_CLOSE` and `struct fuse_backing_map` for build hosts
  whose `<linux/fuse.h>` predates them.
- `FUSE_HAS_BACKING_ID` guard: `fuse_file_info.backing_id` only exists from
  libfuse 3.17, so an older header still compiles and simply never offers
  passthrough.
- `fuse_native_backing_open(thread, fd)` and
  `fuse_native_backing_close(thread, id)`: the `ioctl` that libfuse only
  exposes through the low-level API. The high-level API reaches the same
  session fd via `fuse_session_fd(fuse_get_session(fuse))`. Returns the id
  (> 0) or `-errno`.
- `FUSE_APPLY_FILE_INFO_RESULT` reads an optional backing id from `argv[4]`
  and writes it to `info->backing_id`. libfuse sets `FOPEN_PASSTHROUGH`
  whenever that is > 0.
- The `open` / `opendir` / `create` signal arity went from 2 to 3 so
  `argv[4]` is in range.
- Rejects a backing id combined with `keep_cache` or `direct_io` with
  `EINVAL`. The kernel refuses that combination (`fs/fuse/iomode.c`) and the
  failure would otherwise surface as an opaque `EIO` from `open()`.
- New init config field `max_backing_stack_depth` (mask bit 64, slot 7),
  needed when the backing file's own filesystem is stacked.

### `index.js`

- `backingOpen(fd)` / `backingClose(id)` on the `Fuse` class, throwing an
  `Error` with a `.code` errno name on failure.
- `backingId` accepted on the open/create result object, validated, and
  refused alongside `keepCache` / `directIO`.
- `maxBackingStackDepth` init config field; the config array grew 7 -> 8.
- `Fuse.CAP_PASSTHROUGH` (bit 29) and `Fuse.CAP_ASYNC_READ`.
- `useIno` (`use_ino`) and `negativeTimeout` (`negative_timeout`)
  options, which upstream does not expose, and there is no raw option
  string to pass them through instead. computerd needs `use_ino` so hard
  links stat as one inode, and sets `negative_timeout=0` explicitly so a
  lookup miss is never cached. `negative_timeout` is still a mount
  option, but `use_ino` moved into `struct fuse_config` in FUSE 3 and
  `fuse_new()` rejects it on the command line, so it travels as a new
  operation flag (`FUSE_OPERATION_FLAG_USE_INO`, 32) and the init hook
  sets `config->use_ino`.

### `removal-guard.c` (new), `removal-guard.h` (new), `binding.gyp`

A removal guard for computerd's native roots: local-only directories it
bind-mounts onto the FUSE mount. `rmdir(2)` and `rename(2)` of a mount
point fail with `EBUSY` in the VFS before FUSE is consulted.

- `fuse_native_guard_start(onDetached)` starts a thread, then installs a
  seccomp filter with `SECCOMP_FILTER_FLAG_NEW_LISTENER` on the calling
  thread, without `PR_SET_NO_NEW_PRIVS`, so it needs `CAP_SYS_ADMIN`. The
  filter returns `SECCOMP_RET_USER_NOTIF` for `rmdir`, `rename`,
  `renameat`, `renameat2`, and `unlinkat` with `AT_REMOVEDIR` (tested in
  BPF), and allows everything else, including other architectures and
  x32. Children forked from that thread inherit it. Returns 0 or `-errno`.
- The thread reads each trapped call's path with `process_vm_readv`,
  resolves it lexically against `/proc/<tid>/cwd` or `/proc/<tid>/fd/N`,
  and if it is a registered root, detaches it with
  `umount2("/proc/self/fd/<root fd>", MNT_DETACH)`, then answers
  `SECCOMP_USER_NOTIF_FLAG_CONTINUE`. It answers `CONTINUE` on every path.
  It never resolves a path under the FUSE mount, because the thread whose
  call is trapped may be the one serving FUSE. The thread exists before
  the filter, so it is not filtered itself. After a detach it calls
  `onDetached(path)` through a threadsafe function, unreferenced so it
  does not hold the event loop open.
- `fuse_native_guard_add_root(path, fd)` registers a root and takes
  ownership of `fd`, an open directory at the root of the mount.
  `fuse_native_guard_remove_root(path)` forgets one and closes its
  descriptor. `fuse_native_guard_stats()` returns traps, detaches, roots.
- Linux on x86_64 and aarch64 only; elsewhere every entry point returns
  `-ENOSYS`. Exported from `fuse-native.c`'s init and wrapped in
  `index.js` as `Fuse.removalGuard`, typed in `index.d.ts`.

### `confined-bind.c` (new), `binding.gyp`

Native roots use asynchronous addon calls so resolving a directory under the
FUSE mount cannot block its JavaScript event loop. `bindRoot` resolves both
paths beneath pinned directory descriptors with `openat2` and rejects symlinks.
It clones the source with `open_tree` and attaches it to the pinned target
with `move_mount`, after making the parent and clone private. The source
identity is checked before attachment, so no path-based cleanup follows a
successful mount. `unbindRoot` and `openRoot` likewise resolve beneath the
pinned mount root; the latter hands its descriptor to the removal guard.
If these system calls are unavailable, the bind fails without running a
path-based mount command, leaving the directory served through FUSE.

## Verified on this host

Kernel 6.18, libfuse 3.17.2, btrfs backing store. A mount that requests
`CAP_PASSTHROUGH` at init and returns `{ fd, backingId }` from `open` served
reads and writes with the JavaScript `read` / `write` handlers never invoked,
including two concurrent opens of the same file sharing one refcounted id.
