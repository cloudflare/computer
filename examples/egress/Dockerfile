FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.4.1 AS computerd

FROM debian:trixie-slim

# fuse3 brings libfuse 3. Releases after 0.4.1 link it and need 3.17
# or newer, which is Debian trixie. 0.4.1 and earlier link libfuse 2
# instead, hence libfuse2t64; drop it once the pin above is past 0.4.1.
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
