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

The binary is a Node single executable application. The Node runtime and
the FUSE addon are baked in. libfuse is not: the binary links the
system's libfuse 3 and needs 3.17 or newer, which is the `fuse3` package
on Debian trixie or later. The host also needs `/dev/fuse`, and Linux
6.9 or newer for local-only paths to use FUSE passthrough. computerd
0.4.1 and earlier linked libfuse 2 instead and also need `libfuse2t64`.

This package is private and is not published to npm. The release workflow
builds the binary, stages it into `bin/computerd`, and publishes the image
instead:

```dockerfile
FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.4.1 AS computerd
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

ENV PORT=8080 MOUNT_POINT=/workspace
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/computerd"]
```

Pin the image version explicitly. `latest` is fine for experimentation but
can bite when wire-protocol changes land. The `Next computerd image` workflow
publishes `ghcr.io/cloudflare/computer-computerd-linux-x64:next` after
successful CI on the `release` branch. Use this mutable tag only for tests and
examples that intentionally track release candidates.

## Configuration

`computerd` reads its config from environment variables. The interesting ones:

| var | default | meaning |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket listener port. |
| `MOUNT_POINT` | `/workspace` | Path the FUSE filesystem mounts at. |
| `FUSE_MOUNT` | `auto` | Backend selector. `auto` probes `/dev/fuse` (linux) or macFUSE (darwin) and falls back to the userspace shim. `fuse` and `macfuse` require their respective real backend. `shim` forces the userspace shim. `none` skips the mount entirely; HTTP / WS still come up. |
