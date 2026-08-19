# The release branch expects its matching 0.3.0 computerd image. At repro time
# that image (and the release-candidate :next image) had not been published.
FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.3.0 AS computerd

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
