# Container image for the think example. Identical wiring to
# examples/container — we pull a computerd binary out of the public
# GHCR image, drop it into a slim debian, and run it as PID 1.
# The :VERSION tag is rewritten by the changesets Version Packages PR
# through .github/changeset-version.mjs.
#
# computerd mounts a FUSE filesystem at MOUNT_POINT so exec'd commands
# (git, npm, vitest, …) see the same files the Workspace RPC
# surface reads and writes.


FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.2.0 AS computerd

FROM debian:stable-slim

# We install Node 22 (LTS) from NodeSource so the agent has
# `node`, `npm`, and `npx` on $PATH for the typical "clone the
# repo, npm install, npm test" loop. curl + gnupg are pulled in
# just for the NodeSource key dance and stay in the image; they
# come in handy for ad-hoc agent commands too. The cost is ~120 MB
# of layer over the base; acceptable for an example whose whole
# point is running real build/test workflows.
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

ENV PORT=8080
ENV MOUNT_POINT=/workspace
# FUSE_MOUNT=auto probes /dev/fuse at startup and uses the real
# kernel FUSE backend when available (Cloudflare Containers in
# production) or transparently falls back to the userspace shim
# (wrangler dev, sandboxes without CAP_SYS_ADMIN). Same image works
# in both environments.
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
