# @cloudflare/computer-computerd-linux-x64

> [!IMPORTANT]
> **PREVIEW ONLY** This image is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.
>
> Suitable for experiments, exploration, and prototypes. It is not suitable
> for production use at this time.

Docker image context for the prebuilt `computerd` linux-x64 binary.
`computerd` is the daemon side of [`@cloudflare/computer`](../computer) —
see [`docs/`](../../docs) for the wire protocol and architecture.

The binary is a Node single executable application. Everything needed at
runtime — the Node runtime, `fuse-native`, and libfuse — is baked in. The
host needs `/dev/fuse` and a recent enough kernel for FUSE, nothing else.

This package is private and is not published to npm. The release workflow
builds the binary, stages it into `bin/computerd`, and publishes the image
instead:

```dockerfile
FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.1 AS computerd
FROM debian:stable-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

ENV PORT=8080 MOUNT_POINT=/workspace
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/computerd"]
```

Pin the image version explicitly. `latest` is fine for experimentation but
can bite when wire-protocol changes land. The `Main computerd image` workflow
also publishes `ghcr.io/cloudflare/computer-computerd-linux-x64:main` after
successful CI on `main`; use that mutable tag only for tests and examples
that intentionally track the branch.

## Configuration

`computerd` reads its config from environment variables. The interesting ones:

| var | default | meaning |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket listener port. |
| `MOUNT_POINT` | `/workspace` | Path the FUSE filesystem mounts at. |
| `FUSE_MOUNT` | `auto` | Backend selector. `auto` probes `/dev/fuse` (linux) or macFUSE (darwin) and falls back to the userspace shim. `fuse` and `macfuse` require their respective real backend. `shim` forces the userspace shim. `none` skips the mount entirely; HTTP / WS still come up. |
| `UPSTREAM_URL` | unset | If set, computerd dials this WebSocket on boot and runs a bidirectional sync loop against it. |
