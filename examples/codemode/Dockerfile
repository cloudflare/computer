# Container image for the codemode example.
#
# Both binaries come out of the public GHCR image, a single layer over
# `scratch` holding computerd and codemode at /usr/local/bin. The
# :VERSION tag is rewritten by the changesets Version Packages PR
# through .github/changeset-version.mjs.

FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.2.1 AS computerd

FROM debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends fuse3 libfuse2t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
COPY --from=computerd /usr/local/bin/codemode /usr/local/bin/codemode

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
