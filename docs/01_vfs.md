# 01. Directory structure

> [!NOTE]
> This document reflects what `main` ships today. Sections that
> describe planned-but-unimplemented behaviour are marked
> **(planned)** inline. The schema reserves seats for those
> features (see `packages/dofs/src/schema/`), but the runtime
> wiring is not yet in place.

The workspace exposes a single absolute path namespace rooted at `/`.
The host-side VFS root is always `/` (`ROOT_INODE`); it is not
configurable on the `Workspace` constructor. By convention user data
lives under `/workspace`, which is the default *container* mount point
(configured via the `MOUNT_POINT` env var read by `computerd` inside the
container, not on `WorkspaceOptions`).

```ts
import { Workspace } from "@cloudflare/computer";
import { CloudflareContainerBackend } from "@cloudflare/computer/backends/container";

new Workspace({
  storage:  ctx.storage,
  backends: [
    new CloudflareContainerBackend({
      container: () => this,
      workspace: { binding: "ContainerExample", id: ctx.id.toString() },
    }),
  ],
});
```

`backends` is optional. Omit it to construct a filesystem-only
Workspace where `fs` works against the local SQLite store but
`shell` throws.

`WorkspaceOptions` includes the storage handle, optional backends,
clock, session id, mounts, observer, git identity, assets, artifacts,
and `useThink`. There is no `root` or `sandbox` field on the host
wrapper — sandbox wiring lives behind a `WorkspaceBackend`.

Set `useThink: true` when assigning the Workspace to
`Think.workspace`. This adds Think's string-oriented filesystem
compatibility methods (`readFile`, `readFileBytes`, `writeFile`,
`readDir`, `rm`, `glob`, `mkdir`, and `stat`) to that Workspace and to
clients returned by `getWorkspace()`, while leaving the primary API on
`workspace.fs`.

Illustrative layout (nothing below `/` is auto-created beyond
`ROOT_INODE` itself):

```
/                              # VFS root (do not write here)
└── /workspace                 # conventional container mount point
    ├── /workspace/.agents     # only present if a mount lands here (planned)
    │   └── /workspace/.agents/skills    # typical R2 mount target (planned)
    ├── /workspace/project     # typical GitHub mount target (planned)
    ├── /workspace/documentation
    └── ...                    # everything else is user-defined
```

Only `ROOT_INODE` (`/`) is seeded by `initializeSchema`. `/workspace`
is **not** auto-created on the host side — callers (or the container,
via FUSE) create it like any other directory.

## Conventions

- **Absolute host paths.** Every `workspace.fs` path and command-backend `cwd` takes an absolute
  path starting with `/`. Relative paths are rejected with `EINVAL`.
  Resolve paths against `process.cwd()` (or the `cwd` option on
  `runtime.exec`) at the call site if you need relative semantics.
- **Forward slashes.** Paths are POSIX-style. Backslashes are not
  separators.
- **No trailing slash.** `/workspace/foo` and `/workspace/foo/` are
  the same directory; the canonical form has no trailing slash. The
  root `/` is the one exception.
- **Reserved root.** `/` itself cannot be deleted (`EPERM`),
  cannot be overwritten with `writeFile` (`EISDIR`), and cannot be
  shadowed by `symlink` (`EEXIST`).

## Mount roots (planned; mount feature not yet implemented)

The mount subsystem is reserved in the schema (`_vfs_mounts`,
`vfs_nodes.mount_root`, `vfs_nodes.stub_size`) but is not wired into
`Workspace` or the FS helpers yet. The behaviour below describes the
target shape:

- A mount is anchored at an absolute path inside the workspace. The
  path is the *mount root* and behaves like a directory created by
  `mkdir`. The contents under it are sourced from the mount provider
  on first read.
- Mount roots must be absolute and must not nest. A mount at
  `/workspace/a` and another at `/workspace/a/b` is rejected at
  construction.
- Read-only mounts (the default) reject all writes under their root
  with `EROFS`. Read-write mounts mirror writes back to the provider.
- Writes that originate from `runtime.exec` under a read-only mount
  are silently dropped on the post-exec pull (see
  [02. Sync Protocol](./02_sync_protocol.md)).

`EROFS` is declared in `packages/dofs/src/errors.ts` but no
production call site throws it today.

## Reserved paths

| Path | Notes |
| --- | --- |
| `/` | VFS root. Never delete. Treat as read-only. |
| Mount roots | **(planned)** Cannot be deleted while the mount is configured. Remove the mount from `WorkspaceOptions` instead. |
| `/tmp` (container only) | Not part of the VFS. Lives in the container's own filesystem and is wiped on container restart. This is a consequence of how containers work, not a workspace-fs invariant. |

`/workspace` itself is **not** a reserved path on the host side. It
is treated as any other user directory; `rm` does not specially
protect it. By convention it is the container mount point and so the
place where most user content sits.

Paths like `/workspace/.agents/skills` aren't reserved — they will
only be meaningful once a mount is configured at that path
**(planned)**. Until then they're ordinary paths, and you're free
to use any naming convention you like for your own data.

## Sandbox view

`computerd` (the in-container daemon) mounts the VFS at `MOUNT_POINT`
(default `/workspace`) via FUSE by default. The backend is picked
by the in-image `FUSE_MOUNT` env var (`auto` by default; see doc 07).
On Cloudflare Containers `/dev/fuse` is exposed and the real kernel
FUSE backend mounts; under `wrangler dev` it isn't, and `auto` falls
back to the userspace shim. Either way the in-container view is a
live mirror of the DO-side VFS. Earlier revisions of `CloudflareContainerBackend`
pinned `DISABLE_FUSE=1`, which produced a degraded mode where:

- The in-container filesystem at `/workspace` is the container's own
  FS, not a FUSE-backed view of the DO-side VFS.
- Reads and writes inside the container hit the container FS
  directly; synchronization with the DO-side VFS happens over RPC
  through the post-exec pull bracket and explicit
  `workspace.push()` / `workspace.pull()` calls.
- Writes performed by `runtime.exec` are picked up by the post-exec
  pull. `workspace.push()` flushes pending DO-side writes to the
  container without waiting for the next `exec()`. Use these when
  you need to synchronize the two sides outside of a command run.
- Container-local paths *outside* `/workspace` (e.g. `/usr`, `/tmp`,
  `/app`) are the container's own filesystem and are not synced.

FUSE is the default for full sandbox parity — when enabled, reads
route through the FUSE driver to the in-container VFS mirror and
writes are recorded as dirty and pulled back to the DO on the next
bracket. It is implemented in `computerd` (see `packages/computerd/src/fuse/`)
and selected via `FUSE_MOUNT` (any value other than `none`).

See [06. Mount Interface](./06_mount_interface.md) for mount
semantics and [02. Sync Protocol](./02_sync_protocol.md) for how the
two trees stay in sync.
