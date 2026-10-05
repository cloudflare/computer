---
"@cloudflare/computerd": minor
---

Move to libfuse 3, and serve local-only paths through FUSE passthrough

computerd now mounts through a vendored, patched copy of `fuse-napi`, which
binds libfuse 3, instead of `fuse-native` and libfuse 2.9. This changes what
the container image needs.

The binary links the system libfuse 3 and needs 3.17 or newer. On Debian that
is the `fuse3` package from trixie onward; bookworm's 3.14 is too old.
`libfuse2t64` is no longer needed. A missing or too-old library stops the
binary at startup with a message naming the package to install.

No macOS binary is published any more. Running from source with macFUSE has
not been tested since the move.

With `MOUNT_IGNORE` set and a kernel of Linux 6.9 or newer, opening a
local-only file hands it to the kernel, which then serves its reads, writes,
and mmap straight from the container's disk without going through computerd.
Without kernel support, or without `CAP_SYS_ADMIN`, those paths work as
before and are served by computerd. `/__computerd/info` reports which case
applies in `ignore.fastPaths`, with counts, and `COMPUTERD_FUSE_PASSTHROUGH=0`
turns passthrough off.

Three behavior changes on the synced mount come with the new binding.
`touch -a` and `touch -m` now set the one time they name and leave the other
alone, where before they had no effect. `COMPUTERD_FUSE_AC_ATTR_TIMEOUT` is gone, along with
`ac_attr_timeout` in `COMPUTERD_FUSE_EXTRA_OPTS`: it only tuned `auto_cache`,
which the mount no longer uses. And `COMPUTERD_FUSE_EXTRA_OPTS` entries now
fail the mount, naming the option, when the binding does not recognize them.
