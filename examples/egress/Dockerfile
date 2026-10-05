FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.4.1 AS computerd

FROM debian:trixie-slim

# libfuse2t64 is for the pinned 0.4.1 binary. Later releases need only
# fuse3, at libfuse 3.17 or newer (Debian trixie); drop it then.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
