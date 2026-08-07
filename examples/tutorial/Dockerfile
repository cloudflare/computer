# Container image for the recipe card tutorial. Same wiring as
# examples/think — pull the computerd binary out of the public GHCR image,
# drop it into a slim debian, and run it as PID 1. The :VERSION tag is
# rewritten by the changesets Version Packages PR through
# .github/changeset-version.mjs.
#
# computerd mounts the workspace at MOUNT_POINT, so a file the host writes
# through the Workspace is on disk for pandoc to read, and the PDF
# pandoc writes syncs back to the durable object.

FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.1 AS computerd

FROM debian:stable-slim

ARG PANDOC_VERSION=3.10
ARG TYPST_VERSION=0.15.1

# pandoc converts the agent's markdown; typst is the PDF engine, a
# single 30 MB binary instead of the several hundred megabytes a LaTeX
# install would cost. curl is only the download tool for those two.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl xz-utils \
 && curl -fsSL -o /tmp/pandoc.deb \
      "https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-1-amd64.deb" \
 && dpkg -i /tmp/pandoc.deb \
 && curl -fsSL "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz" \
      | tar -xJ -C /tmp \
 && mv /tmp/typst-x86_64-unknown-linux-musl/typst /usr/local/bin/typst \
 && rm -rf /tmp/pandoc.deb /tmp/typst-x86_64-unknown-linux-musl /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

ENV PORT=8080
ENV MOUNT_POINT=/workspace
# FUSE_MOUNT=auto uses the real kernel FUSE backend when /dev/fuse is
# reachable (Cloudflare Containers) and falls back to the userspace
# shim otherwise (wrangler dev). One image works in both places.
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
