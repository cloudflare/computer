# `@cloudflare/computerd`

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.
>
> Suitable for experiments, exploration and prototypes. It is NOT suitable
> for production use at this time.
>
> The specification under [`docs/`](../../docs/README.md) is forward-looking — read it for
> intent, not as description of the code today.

Computer daemon CLI and FUSE mount package.

## `computerd`

`computerd` starts a FUSE-backed virtual filesystem and an HTTP server. The filesystem is backed by `@platformatic/vfs`, while the FUSE mount is provided by `fuse-native`.

The HTTP server listens on the port provided by the `PORT` environment variable, defaulting to `45678`. The FUSE mount point is provided by `MOUNT_POINT`, defaulting to `/workspace`. The backing VFS stores files under the same absolute prefix: VFS `/workspace/repo/a.txt` is visible to container processes as `/workspace/repo/a.txt`, so capnweb reads, shim materialisation, and shell `exec` agree on absolute paths.

```sh
PORT=45678 MOUNT_POINT=/tmp/workspace npx -p @cloudflare/computerd computerd
```

Current endpoints:

- `GET /health` returns `200 OK` with `ok\n` once the HTTP server is up (it does not currently block on FUSE readiness).
- `GET /__computerd/info` returns JSON with the selected FUSE backend, mount point, and bound port.
- `GET /__computerd/stats` returns JSON with DOFS table row counts, total inline and blob byte sizes, the orphan-blob subset, process resident memory, and the store's own size and free-page count. Useful for watching how the store grows under load.
- `POST /__computerd/checkpoint` folds the store's write-ahead log back into the database file and returns `{ walFrames, sizeBytes, durationMs }`. For a host about to take a disk snapshot. Any other method returns `405`.
- `GET /` returns `200 OK` with an empty JSON object: `{}`.
- `GET /api` upgrades to a WebSocket carrying the capnweb RPC surface backed by `@cloudflare/computer-rpc`. This is the container's only RPC carrier. A request without an `Upgrade` header returns `400`; a handshake naming an unsupported `Sec-WebSocket-Version` returns `426` along with the versions the server speaks.
- `GET /api/watermarks` returns JSON with `currentRev`, `pushRev`, and `fetchCursor`, read through the same `watermarks()` the wire serves. For samplers that want a few numbers without opening a session. It sits under `/api` because it reads the workspace surface; `/__computerd` is for daemon introspection.

All other paths and methods return `404`/`405` with a `text/plain` body.

When `RPC_CLIENT_SECRET` is set, every route above except `/health` requires
it as `Authorization: Bearer <secret>`, and so does the `/api` upgrade.
Requests without it get `401`. Leaving the variable unset disables the
check, which is what the container harnesses rely on.

Current filesystem support:

- `@platformatic/vfs` in-memory filesystem provided by `@cloudflare/dofs`'s node provider.
- FUSE operation adapter covering the full `fuse-native` operation surface.
- Unsupported FUSE operations return `ENOSYS` to the kernel; the binding logs a one-shot warning per operation.
- capnweb RPC over `/api` exposes the workspace database and an `exec` runner to clients.
- Synchronization is driven by whoever holds the other end of the session. The daemon serves `SyncRPC`; it does not run a sync loop of its own.
- Optional on-disk storage through `COMPUTERD_DB`. Unset, the in-memory store is rebuilt at each start and the host sends its state back. Set to a path, the store survives a restart and the host sends only what changed. See [On-disk store](#on-disk-store).

## On-disk store

`COMPUTERD_DB` picks where the workspace lives:

```sh
COMPUTERD_DB=memory                      # default: in-memory, rebuilt on every start
COMPUTERD_DB=/var/lib/computerd/state.db # on-disk, survives a restart
```

The path must be absolute and must not sit inside `MOUNT_POINT`. A database file that the FUSE mount also shows would feed its own writes back to itself. `computerd` refuses to start on either mistake.

Keeping the store on disk saves more than the files. The sync positions live in the same database (`_vfs_watermark`, `_vfs_fetch_cursor`, `_vfs_push_cursor`). Without them a restarted daemon looks further behind than it is, so the durable object sends every path in the workspace again. With them it sends only what changed. On a large workspace that is the difference between resending everything and doing nothing.

The exec log does not persist. `computerd_exec_log` and `computerd_exec_meta` are cleared at every start, because the processes they describe are gone.

### Settings

A file store opens with write-ahead logging, `synchronous = normal`, a 64 MiB page cache, a 256 MiB memory map, temporary tables in memory, and a five-second busy timeout.

`synchronous = normal` flushes to disk when the log is folded back rather than on every commit. That is safe here: the durable object holds the real copy, so a host crash that loses the last few writes costs a resend, not data.

### Checkpointing

- `POST /__computerd/checkpoint` folds the write-ahead log back into the database file and returns `{ walFrames, sizeBytes, durationMs }`. Call it before taking a disk snapshot, so the snapshot holds one file rather than a file plus a log.
- The same thing happens on `SIGTERM` and `SIGINT`, after the FUSE unmount. The order matters: the FUSE driver writes buffered bytes to the database when it releases a file, so unmounting first is what gets those bytes in.
- `GET /__computerd/stats` reports `store_size_bytes` and `store_freelist_count` next to the table counts, so you can watch the file grow.

### Limits

- Take snapshots between commands, not during one. A checkpoint keeps the database itself valid, but a snapshot taken mid-command catches a half-written workspace. A half-finished `npm install` is still half-finished after a restore.
- An older `computerd` exits with `EIO` rather than open a store written by a newer one. Restoring onto an older release fails loudly, which is intended.
- Mount rows (`_vfs_mounts`) come back with the store and may be out of date until the durable object rebuilds them.
- If the store is further ahead than the durable object, the daemon cannot fix it: it answers sync requests but never starts one. Begin from a fresh disk instead.

## FUSE write model

The FUSE driver in `src/fuse/driver.ts` is a thin adapter over the
DOFS provider. The byte owner is DOFS, not the FUSE driver: there
is no per-file staging buffer inside `computerd` for normal writes.

When the backing provider advertises the buffered-write surface
(`openWriteBufferForCreateSync`, `openWriteBufferSync`,
`releaseWriteBufferSync`), the FUSE op map wires up to it directly:

- `create` calls `openWriteBufferForCreateSync` on the provider.
  No SQL runs yet — the new file is held in a path-keyed pending
  buffer inside DOFS.
- `open` on an existing file calls `openWriteBufferSync` so subsequent
  reads and writes route through the same inode-keyed cache.
- `write` and `truncate` mutate the DOFS write buffer directly.
- `read` serves from the buffer when one is open and dirty, otherwise
  from the chunk store via `readRangeSync`.
- `release` commits the buffer to `vfs_chunks` in one transaction
  per file and drops the entry. Pending-create entries do the INSERT,
  dirent, and chunk rows together.

Reads and stats during the open window see the buffered bytes. RPC
or sync callers reading through the VFS surface get the same view
as the in-flight FUSE writer.

When the provider does not expose the buffered surface (legacy
in-process tests, alternate providers), the driver falls back to the
old staged path: per-file in-memory `FileEntry` buffer that spills on
`release` / `flush` / `fsync`. The fallback is exercised by tests
that explicitly disable the direct-write methods on the VFS.

### `/__computerd/stats` for diagnosis

When a workload is misbehaving — orphan blobs piling up, RSS growing
faster than expected, dirty buffers stuck — `GET /__computerd/stats` is the
first port of call. It returns table counts, total and orphan blob
byte sizes, inline byte totals, and the process's RSS/heap/external
figures. Poll it during a long-running install or test to watch
how the store grows.

## Local-only paths (`MOUNT_IGNORE`)

Everything a container command writes under `MOUNT_POINT` is recorded in
the VFS and pulled into the Durable Object after the command. That is
right for source and wrong for `node_modules`, `.venv`, `target/`,
`dist/` and caches: tens of thousands of rebuildable files that never
need to be durable. `MOUNT_IGNORE` names paths that stay on the
container's local disk instead. They are never recorded, pushed, or
pulled.

Content under a local-only path is visible only inside the container;
`workspace.fs` and the worker shell do not see it. It is absent from
sync, so a container replaced without a snapshot restore loses it. It
does survive a container snapshot, because `MOUNT_IGNORE_PATH` is a real
filesystem path, which is why the default sits under `/tmp` rather than
on a tmpfs. That suits a dependency tree a package manager can rebuild,
not anything a user typed.

### Configuration

`ContainerBackend` takes an `ignore` option and passes it to the
container's start environment, so changing the patterns is a deployment
change rather than an image rebuild. `LegacyContainerBackend` has no
such option; set `MOUNT_IGNORE` through its `containerEnv` instead.

```ts
new ContainerBackend({
  container: env.CONTAINER,
  workspace: { binding: "SESSIONS", id: sessionId },
  ignore: ["**/node_modules", "!/vendor/node_modules", "**/.venv", "/dist"],
});
```

That becomes
`MOUNT_IGNORE=**/node_modules,!/vendor/node_modules,**/.venv,/dist`.
Setting the variable directly, in `containerEnv` or a Dockerfile, works
too and takes precedence. `MOUNT_IGNORE_PATH` sets where local-only
content is stored and defaults to `/tmp` + `$MOUNT_POINT`.

### Patterns

`MOUNT_IGNORE` is a comma-separated list of glob patterns, a small
subset of gitignore. Every pattern starts with `/` (from the mount root)
or `**/` (at any depth):

| Pattern | Means |
| --- | --- |
| `/dist` | `$MOUNT_POINT/dist` and everything under it |
| `/workspace/dist` | the same; the mount point is optional |
| `**/node_modules` | `node_modules` at any depth, including the root |
| `/packages/*/dist` | `*` matches within one path segment and never crosses `/` |
| `/app/**/node_modules` | any depth under `app` |
| `**/*.tsbuildinfo` | single files work too |
| `!/vendor/node_modules` | an exclusion: keeps a path synced |

A pattern names a path and everything under it, so `/cache` and
`/cache/**` mean the same thing. A trailing `/` is ignored. Matching is
case-sensitive.

The last matching pattern wins, and a path is local-only if it or any
directory above it is ignored. That is git's rule, and it decides what
an exclusion can do. `**/node_modules,!/vendor/node_modules` keeps
`vendor/node_modules` synced, because the exclusion applies at the same
level as the match. `**/node_modules,!**/node_modules/.bin` does nothing:
once `node_modules` is on local disk, the synced side has no directory
for `.bin` to live in. computerd warns about an exclusion like that at
startup.

These fail the daemon at startup, because a dropped pattern means a full
`node_modules` goes into the Durable Object:

| Pattern | Why |
| --- | --- |
| `node_modules` | not anchored. In gitignore it would match at any depth; write `/node_modules` or `**/node_modules` |
| `**node_modules`, `/a**/b` | `**` must be a whole path segment |
| `**`, `/**`, `/`, `/*`, `**/*` | would make the whole mount local-only. A pattern of only `*` and `**` segments matches every top-level entry, and everything under a local-only directory is local-only |
| `/a/../b`, `/./a`, `/a//b` | `.`, `..`, and empty segments |
| `/*.{js,ts}`, `/[ab]`, `/a?`, `/a\*` | braces, character classes, `?`, and escapes aren't supported |

A pattern can't contain a comma, since commas separate patterns.
`ContainerBackend` checks `ignore` against the same rules in its
constructor, so a typo throws before a container starts.

`MOUNT_IGNORE_PATH` must be absolute, must not be `/`, and must not be
equal to or inside `MOUNT_POINT`, since a root inside the mount would
resolve into itself.

### Checking what the container applied

The patterns are compiled once at startup, so they can't change under a
running container, and two sessions sharing one container see the same
durability boundary. `connect()` reads the applied patterns back off
`/__computerd/info` and refuses the connection unless they match what
was declared, in the same order, since order changes the meaning. That
catches a computerd too old to read patterns, and a `MOUNT_IGNORE` in
`containerEnv` overriding the option. The handle exposes them:

```ts
const handle = await backend.connect();
handle.ignore;
// {
//   patterns: ["**/node_modules", "!/vendor/node_modules", "**/.venv", "/dist"],
//   root: "/tmp/workspace",
//   mountPoint: "/workspace",
//   supported: true,
// }
```

`supported: false` means the container predates patterns and every path
is synced.

`/__computerd/info` reports the patterns in computerd's normalized
spelling, with the mount point and trailing slashes removed:

```jsonc
{
  "ignore": {
    "supported": true,
    "enabled": true,
    "root": "/tmp/workspace",
    "patterns": ["**/node_modules", "!/vendor/node_modules", "!**/node_modules/.bin"],
    "ineffectiveExclusions": ["!**/node_modules/.bin"],
    "fastPaths": {
      "passthrough": false,
      "passthroughReason": "fuse-native binds libfuse 2.9; FOPEN_PASSTHROUGH requires the libfuse 3.17 API",
      "writebackCache": false
    }
  }
}
```

`fastPaths.passthrough` is `false` on current builds by design. Ignored
writes skip the VFS and the transfer but still cross FUSE; see
[19. Performance](../../docs/19_performance.md#local-only-paths-mount_ignore).

### Synced directories that hold local-only paths

A local-only path is stored at the same relative path under
`MOUNT_IGNORE_PATH`, so `packages/app/node_modules` lives at
`/tmp/workspace/packages/app/node_modules`. The parent `packages/app`
stays synced. computerd keeps the two sides in step:

- Listing a synced directory includes its local-only children.
- Renaming a synced directory moves its local-only contents too. The
  two moves can't be atomic together, so if the local one fails, the
  rename still succeeds and computerd logs where the contents were left.
  A rename that changes which patterns match, such as moving a
  directory out from under `/app/**/node_modules`, leaves contents on
  local disk that are no longer local-only and so aren't reachable;
  prefer `**/` patterns for trees that get moved.
- Removing a synced directory, or renaming another directory onto it,
  returns `ENOTEMPTY` while it still holds local-only contents, which
  the synced side can't see. `rm -rf` removes
  the contents first, so it works as usual.

### Renames across the boundary

A rename whose source and destination sit on opposite sides of the
boundary returns `EXDEV` (`Invalid cross-device link`). The two sides are
different filesystems, so the rename cannot be atomic, and copying then
unlinking would fake the atomicity `rename(2)` promises. `mv` and
Python's `shutil.move` copy instead when they see `EXDEV`, but a program
that calls `rename` directly, such as Node's `fs.rename` or Go's
`os.Rename`, gets the error. Renames within one side are ordinary atomic
renames. Hardlinks across the boundary return `EXDEV` for the same
reason.

The usual cause is a build tool that stages into a sibling directory and
renames into place. The fix is to ignore the staging path too:

```ts
ignore: ["/dist", "/.tmp-build"];
```

With `**/` patterns, keep staging directories and their destinations on
the same side: `**/node_modules` already covers anything a package
manager stages inside `node_modules`.

Candidates worth checking are `.next`, `.turbo`, `node_modules/.cache`,
and any staging directory a bundler creates next to its output.
computerd logs this guidance on the first crossing rename per mount,
naming both sides and the entry to add. Later occurrences are not
logged, but `GET /__computerd/stats` counts them all under
`localPaths.crossLayerRenames`.

### `MOUNT_IGNORE` versus `fetchChanges({ ignore })`

`MOUNT_IGNORE` works at the mount: the path never enters the VFS.
`fetchChanges({ ignore })` works at the sync RPC: the path is skipped in
one transfer but still occupies the container's store. A wrapper that
injects `ignore` into `fetchChanges` to keep a dependency tree out of the
Durable Object should be deleted in favor of `MOUNT_IGNORE`.

## FUSE prerequisites

Linux hosts/containers need access to `/dev/fuse` and mount permissions.

### macOS: macFUSE

Install macFUSE. On Apple Silicon, macFUSE may require Reduced
Security / kernel extension approval. FUSE-T is intentionally
unsupported — the libfuse2 surface our `fuse-native` dependency
wraps does not work against the FUSE-T userland.

Pick the backend with `FUSE_MOUNT`:

```sh
FUSE_MOUNT=auto    # default: probe /dev/fuse or macFUSE, fall back to the userspace shim
FUSE_MOUNT=fuse    # require the linux kernel FUSE backend (/dev/fuse)
FUSE_MOUNT=macfuse # require macFUSE on darwin
FUSE_MOUNT=shim    # force the userspace dev shim (no FUSE)
FUSE_MOUNT=none    # skip the mount entirely; HTTP and /api still come up
```

Additional environment variables:

```sh
EXEC_LOG_MAX_BYTES=1048576        # cap the in-memory exec log buffer (bytes)
EXEC_SHELL=/usr/bin/bash          # interpreter exec runs commands under (default /bin/sh)
RPC_CLIENT_SECRET=<secret>        # require Authorization: Bearer <secret> on every route but /health
COMPUTER_VAR_NODE_ENV=production  # forwarded into exec as NODE_ENV
COMPUTERD_DB=/var/lib/computerd/state.db  # on-disk store; "memory" or unset keeps it in memory
```

`EXEC_SHELL` must be an absolute path. It exists because `/bin/sh` is `dash` on a Debian-family image, where bash-only syntax is a parse error that aborts the command rather than a missing feature: `${PIPESTATUS[@]}`, arrays, `[[ ... ]]`, and process substitution all fail that way. `PIPESTATUS` is the usual way to recover the real exit status of a pipeline whose output is filtered — a command redacting a credential through `sed`, for instance — so a caller that needs it can select an interpreter that has it without repointing `/bin/sh` for every other script in the image.

`FUSE_MOUNT=auto` is the friendly default: if `/dev/fuse` (or macFUSE) is available `computerd` mounts a real FUSE filesystem, otherwise it transparently falls back to the userspace shim. Pin the value (`fuse` / `macfuse` / `shim` / `none`) when a test needs to assert a specific code path.

## `FUSE_MOUNT=shim` — userspace dev shim

When `FUSE_MOUNT=shim` is set (or auto-detection picked it because no kernel FUSE was available), `computerd` materialises the VFS subtree rooted at `MOUNT_POINT` onto the host filesystem at the same path and keeps the two in sync without touching the kernel. The shim is intended for local development on machines that can't run FUSE (most CI, macOS without macFUSE, Linux containers without `/dev/fuse`).

How it works:

- On boot, `computerd` walks the VFS subtree under `MOUNT_POINT` and writes every file out to the host at the same path.
- `vfs.watchAsync(MOUNT_POINT, { recursive: true })` drives VFS → disk: each VFS revision turns into a host-fs `writeFile`/`mkdir`/`rm`.
- A periodic poll (~250 ms) walks `MOUNT_POINT`, diffs it against a content-hash shadow, and pushes any new or changed entries into the VFS.
- The shadow doubles as a loop suppressor: after a write in either direction the shadow matches both sides, so the next tick on the opposite side sees no diff.

`exec` runs with `cwd=MOUNT_POINT` exactly as it does under real FUSE, so a child process that writes into the mount point ends up writing through the shim into the VFS, and onward to the host on its next pull.

Caveats. The shim is dev-only:

- Conflicting writes across the seam are resolved on the next reconcile tick; the shim does not guarantee process-level coherence.
- Symlinks, xattrs, chmod/chown, and watch fan-out are not modelled. Real FUSE keeps them; the shim treats files and directories only.
- Large files cost a full read on every change. Don't park multi-GB blobs in the shim path.
- Migration: `DISABLE_FUSE`, `FUSE_SHIM`, and `WSD_FUSE_BACKEND` have been removed in favour of `FUSE_MOUNT`. `computerd` exits non-zero at startup if any of the old vars are set.

## Tests

Tests live next to the source files and are written in TypeScript. Vitest runs them directly:

```sh
npm test --workspace=@cloudflare/computerd
```

The test command does not build first. Some suites need build output that is not there in a clean checkout: the tests import the sibling `@cloudflare/dofs` and `@cloudflare/computer-rpc` packages from their `dist/` directories, and `src/cli/computerd.test.ts` spawns the bundled CLI at `dist/cli/computerd.cjs`. Run `npm run build` across the workspace before `npm test`, or those tests fail to resolve the imports or exit early with no bundle to spawn.

This package requires Node.js 22+ because `@platformatic/vfs` does.

The two real-FUSE suites gate themselves differently. `src/cli/computerd.test.ts` runs its real-FUSE case only when `/dev/fuse` is reachable; otherwise auto-detection resolves to the shim and the case skips. The guard is a bare existence check, so a `mknod`'d `/dev/fuse` in an unprivileged container defeats the skip and the mount then fails with `EPERM` — leave the device absent unless the container is privileged (`--privileged`, or `CAP_SYS_ADMIN` with device access). `src/exec/runner.fuse.test.ts` is separate: it skips unless both Docker and the prebuilt `computerd` binary are available, and runs `computerd` inside a privileged container, so the host's `/dev/fuse` does not matter. See the [`debugging-computerd-fuse`](../../.agents/skills/debugging-computerd-fuse/SKILL.md) skill for the privileged Docker setup.

## Standalone release artifacts

Standalone binaries are release artifacts, not files published in the npm package:

```sh
npm run build:bin --workspace=@cloudflare/computerd
```

The binary is produced with Node's Single Executable Application (SEA) feature: `scripts/build-bin.mjs` bundles the CLI with `esbuild`, generates a SEA blob via `node --experimental-sea-config`, downloads the target's Node binary, and injects the blob with `postject`. macOS targets are stripped and re-signed ad-hoc. `fuse-native` prebuilds and `libfuse` are embedded as SEA assets per target.
