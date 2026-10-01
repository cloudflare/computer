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

All changes are in `fuse-native.c` and `index.js`.

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

## Verified on this host

Kernel 6.18, libfuse 3.17.2, btrfs backing store. A mount that requests
`CAP_PASSTHROUGH` at init and returns `{ fd, backingId }` from `open` served
reads and writes with the JavaScript `read` / `write` handlers never invoked,
including two concurrent opens of the same file sharing one refcounted id.
