FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.2.1 AS computerd

FROM debian:stable-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends fuse3 libfuse2t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/computerd"]
