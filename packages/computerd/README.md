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
- `GET /__computerd/stats` returns JSON with DOFS table row counts, total inline and blob byte sizes, the orphan-blob subset, and process resident memory. Useful for watching how the store grows under load.
- `GET /` returns `200 OK` with an empty JSON object: `{}`.
- `GET /api` upgrades to a WebSocket carrying the capnweb RPC surface backed by `@cloudflare/computer-rpc`. This is the container's only RPC carrier. A request without an `Upgrade` header returns `400`; a handshake naming an unsupported `Sec-WebSocket-Version` returns `426` along with the versions the server speaks.
- `GET /api/watermarks` returns JSON with `currentRev`, `pushRev`, and `fetchCursor`, read through the same `watermarks()` the wire serves. For samplers that want a few numbers without opening a session. It sits under `/api` because it reads the workspace surface; `/__computerd` is for daemon introspection.

All other paths and methods return `404`/`405` with a `text/plain` body.

Current filesystem support:

- `@platformatic/vfs` in-memory filesystem provided by `@cloudflare/dofs`'s node provider.
- FUSE operation adapter covering the full `fuse-native` operation surface.
- Unsupported FUSE operations return `ENOSYS` to the kernel; the binding logs a one-shot warning per operation.
- capnweb RPC over `/api` exposes the workspace database and an `exec` runner to clients.
- Synchronization is driven by whoever holds the other end of the session. The daemon serves `SyncRPC`; it does not run a sync loop of its own.
- No on-disk persistence yet — the in-memory VFS is rebuilt on each start, and the host pushes state back after a restart.

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
EXEC_LOG_MAX_BYTES=1048576  # cap the in-memory exec log buffer (bytes)
```

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
