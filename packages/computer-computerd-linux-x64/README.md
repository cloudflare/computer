# @cloudflare/computer-computerd-linux-x64

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.
>
> Suitable for experiments, exploration and prototypes. It is NOT suitable
> for production use at this time.

Prebuilt `computerd` binary for linux-x64. `computerd` is the daemon
side of [`@cloudflare/computer`](../computer) — see [`docs/`](../../docs)
for the wire protocol and architecture.

The binary is a Node SEA (Single Executable Application). Everything
needed at runtime — the Node runtime, fuse-native, libfuse — is baked
in. The host needs `/dev/fuse` and a recent enough kernel for FUSE,
nothing else.

## Install

```sh
npm install @cloudflare/computer-computerd-linux-x64
```

Adds `computerd` to `node_modules/.bin/`. On any host that isn't linux-x64
npm refuses the install via the package's `os` / `cpu` constraints —
that's intentional.

## Docker

The intended path. Multi-stage build pulls the binary from npm,
copies it into a minimal runtime image:

```dockerfile
FROM node:22-slim AS computerd
RUN npm install --no-save --omit=dev \
    @cloudflare/computer-computerd-linux-x64@0.1.1

FROM debian:stable-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd \
  /node_modules/@cloudflare/computer-computerd-linux-x64/bin/computerd \
  /usr/local/bin/computerd

ENV PORT=8080 MOUNT_POINT=/workspace
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/computerd"]
```

No local SEA build, no binary staged into the build context. Pin the
version explicitly — `latest` is fine for experimentation but bites in
production when wire-protocol changes land.

## Configuration

`computerd` reads its config from environment variables. The interesting ones:

| var | default | meaning |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket listener port. |
| `MOUNT_POINT` | `/workspace` | Path the FUSE filesystem mounts at. |
| `FUSE_MOUNT` | `auto` | Backend selector. `auto` probes `/dev/fuse` (linux) or macFUSE (darwin) and falls back to the userspace shim. `fuse` and `macfuse` require their respective real backend. `shim` forces the userspace shim. `none` skips the mount entirely; HTTP / WS still come up. |
| `UPSTREAM_URL` | unset | If set, computerd dials this WebSocket on boot and runs a bidirectional sync loop against it. |
