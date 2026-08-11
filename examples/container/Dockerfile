# Container image for the container example.
#
# Pulls the computerd binary out of the public GHCR image. That image is
# a single layer over `scratch` whose only contents are the SEA
# binary at /usr/local/bin/computerd; we COPY it into a slim debian
# runtime below. The :VERSION tag is rewritten by the changesets
# Version Packages PR through .github/changeset-version.mjs.
#
# computerd mounts a FUSE filesystem at MOUNT_POINT so exec'd commands
# see the same VFS the RPC surface reads and writes. With
# FUSE_MOUNT=auto (below) the same image works in both directions:
# Cloudflare Containers expose /dev/fuse to the workload, so the
# real FUSE backend mounts; `wrangler dev` doesn't, so computerd falls
# back to the userspace shim transparently.


FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.2.0 AS computerd

FROM debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl gnupg git \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

# computerd's defaults: HTTP+WS on :8080, FUSE mount on MOUNT_POINT.
# FUSE_MOUNT=auto picks real FUSE on Cloudflare Containers (where
# /dev/fuse is exposed) and the userspace shim under wrangler dev.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
