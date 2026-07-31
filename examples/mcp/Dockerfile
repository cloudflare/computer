FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.2.0 AS computerd

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl fuse3 git libfuse2 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/computerd"]
