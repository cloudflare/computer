# syntax=docker/dockerfile:1
# Image-only distribution of remote-exec, the in-container half of
# @cloudflare/computer/remote-exec. Like the computerd image, it isn't meant to be run: it ships
# the static binary at a known path so downstream Dockerfiles can `COPY --from`:
#
#   FROM ghcr.io/cloudflare/computer-remote-exec:0.11.0 AS remote-exec
#   FROM debian:stable-slim
#   COPY --from=remote-exec /usr/local/bin/remote-exec /usr/local/bin/remote-exec
#
# Built for linux/amd64 and linux/arm64 from the binaries attached to the @cloudflare/computer
# GitHub release, so a Worker carrying those finds its own build already installed. The build
# context is artifacts/remote-exec (`npm run build:bin --workspace @cloudflare/remote-exec`):
#
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     --file packages/remote-exec/Dockerfile artifacts/remote-exec
ARG TARGETARCH

FROM scratch AS amd64
COPY --chmod=755 remote-exec-linux-x86_64 /usr/local/bin/remote-exec

FROM scratch AS arm64
COPY --chmod=755 remote-exec-linux-aarch64 /usr/local/bin/remote-exec

FROM ${TARGETARCH}
LABEL org.opencontainers.image.source="https://github.com/cloudflare/computer"
LABEL org.opencontainers.image.description="remote-exec, the in-container half of @cloudflare/computer/remote-exec"
LABEL org.opencontainers.image.licenses="MIT"
# `docker run` prints the version, protocol and hash; consumers declare their own entrypoint.
ENTRYPOINT ["/usr/local/bin/remote-exec"]
CMD ["--version"]
