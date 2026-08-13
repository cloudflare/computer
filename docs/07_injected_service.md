# 07. Injected Service

> [!NOTE]
> This doc now reflects shipped code in `packages/computerd/` and
> `packages/computer/src/backends/`. Items marked **(planned)** are
> deferred work.

The "injected service" is the workspace daemon that runs *inside* the
sandbox container. It owns the FUSE mount, the in-container VFS, the
exec runner, and the capnweb RPC endpoint the DO talks to.

The package ships it as a single self-contained Node SEA binary —
**`computerd`** — produced by `packages/computerd/` (npm package
`@cloudflare/computerd`, bin name `computerd`). The binary embeds Node,
the `fuse-native` prebuilds, and `libfuse` as SEA assets, so the host
image does **not** need a Node runtime. Build it with:

```bash
npm run build:bin --workspace @cloudflare/computerd
# → artifacts/computerd/computerd-linux-x64
# → artifacts/computerd/computerd-macos-x64
```

`examples/container/Dockerfile` is the canonical recipe for
staging the binary into a container image.

## Responsibilities

1. **FUSE mount.** Mounts the in-container VFS at `MOUNT_POINT`
   (default `/workspace`) so any tool that runs inside the container —
   node, shells, compilers — sees the same tree the DO sees, with the
   same paths. The backend is picked by `FUSE_MOUNT` (default `auto`,
   see the env-var table below).
2. **Dirty tracking.** Writes that flow through FUSE land in the
   in-container VFS database; sync (when `UPSTREAM_URL` is set) is
   what surfaces those revisions back out. See doc 02 for the sync
   protocol.
3. **Exec.** Runs shell commands and streams stdout/stderr back over
   capnweb. See [05. Shell Interface](./05_runtime_interface.md).
4. **Apply.** Accepts changes pushed by the DO and writes them into
   the VFS, suppressing its own dirty-tracking so deletes don't bounce
   back.
5. **Health.** Exposes `GET /health` so the host-side workspace can
   probe for readiness before opening the RPC connection.

## HTTP / WS surface

`computerd` listens on a single port (default `45678`; the Cloudflare
backend pins it to `8080`) and serves:

| Route | Method | Purpose |
| --- | --- | --- |
| `/health` | `GET`, `HEAD` | Liveness probe; `200 ok\n` as soon as the HTTP server binds. |
| `/__computerd/info` | `GET` | Runtime info: FUSE backend, mount point, port. |
| `/api` | `POST` | HTTP-batch capnweb transport. |
| `/ws` | `GET` (upgrade) | WebSocket capnweb transport — the bootstrap stub is `WorkspaceRPC`. |
| `/connect` | `POST` | Tells `computerd` to dial *out* to a caller-supplied URL and serve a `WorkspaceRPC` session over that outbound WebSocket. Used by the Cloudflare backend (see below). |
| `/` | `GET` | Banner/info page. |

The capnweb bootstrap interface is **`WorkspaceRPC`** (defined in
`packages/rpc/`), split into `sync` and `shell` sub-stubs.

## Installing into your sandbox image

The canonical recipe is `examples/container/Dockerfile`:

```dockerfile
FROM --platform=linux/amd64 debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY build/computerd-linux-x64 /usr/local/bin/computerd
RUN chmod +x /usr/local/bin/computerd

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
```

Notes:

- No Node, no `npm install`, no `package.json` — the SEA binary
  embeds everything.
- `libfuse` itself is bundled into the binary as a SEA asset; the apt
  install of `fuse3 libfuse2t64` provides the userland tooling and
  `/dev/fuse` plumbing for the host kernel.
- `EXPOSE 8080` matches the Cloudflare backend's pinned port. If you
  run `computerd` outside Cloudflare Containers, leave `PORT` unset (default
  `45678`) or pick your own.
- The port is currently hard-coded in code via `DEFAULT_PORT`; making
  it a build-time variable is on the roadmap **(planned)**.

## Boot sequence

Provider-agnostic shape — three steps, in order:

1. **Start the binary.** The host-side workspace asks its sandbox
   provider to launch `computerd` as the container's entrypoint.
2. **Poll the health endpoint.** The host issues `HEAD /health` until
   it returns `200`. Caveat: `/health` is wired by the HTTP server and
   answers `200` as soon as the socket binds. In the FUSE-enabled
   path the mount is awaited *before* `listen`, so by the time
   `/health` answers FUSE is up too. With `FUSE_MOUNT=none` there is
   no FUSE step at all.
3. **Open the capnweb session.** Either the host upgrades to `/ws`
   directly, or it asks `computerd` (via `POST /connect`) to dial *out* to a
   URL it controls and serve the session over that outbound socket.
   Either way, the bootstrap stub is `WorkspaceRPC`.

### Cloudflare Containers specifics

`CloudflareContainerBackend` (`packages/computer/src/backends/container/cloudflare-container.ts`)
wires it like this:

1. **Start.** `container.start({ enableInternet, env })` on the
   Cloudflare Containers API — not the `@cloudflare/sandbox` SDK.
   Idempotence comes from `container.running` plus a cached `#handle`;
   there is no process-name registry, no `startProcess`/`getProcess`,
   and no `node /app/...` command (the container's `ENTRYPOINT` runs
   `computerd` directly). `containerEnv` pins `PORT=8080` and lets the
   image's own `FUSE_MOUNT` value (typically `auto`) win.
2. **Wire egress.** `container.interceptOutboundHttp(egressHost, egress)`
   routes outbound HTTP from the container at `egressHost` back to a
   Worker `Fetcher` the DO controls.
3. **Probe.** `container.getTcpPort(containerPort).fetch("/health", { method: "HEAD" })`,
   repeated until it returns `200`.
4. **Invert the WebSocket.** The DO arms an upgrade slot
   (`#armUpgrade`) and then `POST`s to `/connect` on the container
   (`#postConnect`). `computerd` reads that request and dials *out* to the
   egress at `${egressHost}/ws`. Because the egress is intercepted,
   that outbound dial loops back to the DO's `handleFetch()`, which
   accepts the upgrade and resolves the in-flight `#pendingUpgrade`.
   The capnweb session then runs over that socket. **The WebSocket
   carrier is inverted** versus a naive "host dials into container"
   model.

Sharp edges actually present in `cloudflare-container.ts`:

- `#armUpgrade` must be set up *before* `#postConnect`, because `computerd`
  can dial back before the `POST /connect` response returns.
- The container host records each monitored generation's exit reason. The dead container closes its WebSocket, and `fetchPort()` also short-circuits later requests with a transport error; either path invalidates the matching Workspace handle.
- **Reconnect replaces the whole session.** If the WebSocket dies, `Workspace` invalidates and closes the matching backend handle, then calls `CloudflareContainerBackend.connect()` again. The replacement runs the complete start, egress-interception, health, `/connect`, and reverse-WebSocket sequence; the backend never splices a new carrier into the dead capnweb session. Replay-safe sync and process lifecycle operations get one retry. Command spawn is retried only when no request was dispatched.

## Environment variables

These are the variables `computerd` actually consumes (see
`packages/computerd/src/cli/computerd.ts` and `packages/computerd/src/fuse/backend.ts`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `45678` | Port the HTTP/WS server listens on. CF backend pins this to `8080`. |
| `MOUNT_POINT` | `/workspace` | Absolute path inside the container to mount the FUSE filesystem at. Ignored when `FUSE_MOUNT=none`. |
| `FUSE_MOUNT` | `auto` | Backend selector: `auto` probes `/dev/fuse` (linux) or macFUSE (darwin) and falls back to the userspace shim; `fuse` / `macfuse` require the corresponding real backend; `shim` forces the userspace shim; `none` skips the mount entirely. |
| `UPSTREAM_URL` | unset | If set, `computerd` starts a sync client against this URL to push/pull VFS revisions. |
| `EXEC_LOG_MAX_BYTES` | runner default | Caps the per-exec stdout/stderr log retained in-memory. |
| `LOG_FILE` | unset | If set, every `console.log` / `console.error` line and any `uncaughtException` / `unhandledRejection` is also appended to this file. Stdout/stderr behaviour is unchanged. |

When `LOG_FILE` is set, `computerd` mirrors console output into the file in
addition to stdout/stderr. See "Failure handling" below for the crash
handlers that share the same logger.

## Failure handling

Today:

- `computerd` installs `uncaughtException` and `unhandledRejection`
  handlers via `installLogging()` (in `cli/logger.ts`). Each handler
  writes a formatted entry to the same logger — `console.error` and,
  if `LOG_FILE` is set, the file too — then calls `process.exit(1)`.
- Logs go to stdout/stderr by default. When `LOG_FILE` is set, every
  `console.log` / `console.error` line is also appended to that file
  (open in `O_APPEND` mode, ISO-timestamped, `[info]` / `[error]`
  prefixed). No rotation; the operator is expected to manage the file.
- `FUSE_MOUNT=fuse` (or `macfuse`) errors at startup if the
  corresponding kernel surface isn't available; `FUSE_MOUNT=auto`
  silently falls back to the userspace shim instead. The only
  "skip the mount entirely" path is the explicit `FUSE_MOUNT=none`
  opt-out.

**Planned**:

- Soft-fail on FUSE-detect failure: the server still starts, exposes
  RPC, and reports `fuseActive=false` via `/__computerd/info`. Whether
  that includes a host-FS mirror for in-container writes is still
  open.

## Lifetime

The `computerd` process is long-lived and outlives Durable Object restarts — the sandbox container is reaped only when its lifetime policy says so, and a fresh Durable Object incarnation reconnects to the same running daemon over a new WebSocket. The container monitor and transport error classifier drop stale handles so an operation can reconnect through the readiness gate.

Caveat: **no on-disk persistence yet** (`packages/computerd/README.md`). The same in-memory VFS across Durable Object restarts only holds while the container process is alive. A container restart loses VFS state. Watermark reconciliation and the next push rebuild the mirror from Durable Object storage, but reconnect cannot recover container-local files that were never pulled before the process died.

## Open questions

These behaviours aren't fully specified yet. File an issue if your
use case depends on a particular resolution.

- **Connection auth.** Today the WebSocket endpoint trusts anything
  that can reach the port. On Cloudflare Containers that's safe
  because only the owning DO can reach the container's TCP port, but
  the moment we support providers with broader network exposure the
  server needs its own auth on the RPC handshake. Candidates: a
  short-lived shared secret minted by the workspace and passed via an
  env var, a per-connection challenge, or an mTLS client cert
  provisioned at boot. The wire surface
  ([08. Capnweb Interface](./08_capnweb_interface.md)) will need a
  hello/auth phase before the bootstrap stub is exposed.
- **Process user and file ownership.** `computerd` currently runs as
  whatever user the sandbox image's `ENTRYPOINT` runs as — typically
  `root`, which is a poor default for a process that mounts FUSE and
  spawns arbitrary shell commands. The intent is to run `computerd` as an
  unprivileged user so a misbehaving exec can't escalate, *but*
  exec'd commands need to be able to read and write the FUSE-mounted
  tree. Open: which user owns the mount, what user `exec` runs as
  (`workspace`? per-exec dynamic?), and how `allow_other` / setuid /
  shared-group ownership get wired so the two see the same files
  without opening the mount to every process in the container.
- **FUSE soft-fail behaviour.** See "Failure handling" above —
  whether the degraded `fuseActive=false` mode includes a host-FS
  mirror or just refuses container-side writes is unresolved.
