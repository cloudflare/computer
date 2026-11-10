#!/usr/bin/env bash
# Run a command in a Linux container with Node, Rust (both musl targets) and capnp
# (packages/remote-exec/dev/Dockerfile), with the repository mounted at /workspace, building the
# image first. node_modules and cargo's target directory live in volumes per checkout and
# platform, so the container's Linux builds never mix with the host's; cargo's registry is shared.
# From the repository root:
#
#   packages/remote-exec/dev/run.sh npm ci --ignore-scripts
#   packages/remote-exec/dev/run.sh npm run build:dev --workspace @cloudflare/remote-exec
#   packages/remote-exec/dev/run.sh npm run test:remote-exec --workspace @cloudflare/computer
#   PLATFORM=linux/arm64 packages/remote-exec/dev/run.sh npm run test:rust --workspace @cloudflare/remote-exec
#   packages/remote-exec/dev/run.sh bash
#
# PLATFORM defaults to linux/amd64, what Cloudflare's containers run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PLATFORM="${PLATFORM:-linux/amd64}"
ARCH="${PLATFORM#linux/}"
IMAGE="remote-exec-dev:$ARCH"
VOLUME="remote-exec-dev-$(printf %s "$ROOT" | shasum | cut -c1-8)-$ARCH"
SECRET=()
[ -n "${NODE_EXTRA_CA_CERTS:-}" ] && SECRET=(--secret "id=ca,src=$NODE_EXTRA_CA_CERTS")
RUST_TOOLCHAIN="$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$ROOT/packages/remote-exec/rust-toolchain.toml")"
docker build -q --platform "$PLATFORM" ${SECRET[@]+"${SECRET[@]}"} --build-arg "RUST_TOOLCHAIN=$RUST_TOOLCHAIN" \
  -t "$IMAGE" "$ROOT/packages/remote-exec/dev" >/dev/null
TTY=()
[ -t 0 ] && TTY=(-it)
exec docker run --rm --platform "$PLATFORM" ${TTY[@]+"${TTY[@]}"} \
  -v "$ROOT:/workspace" \
  -v "$VOLUME-node-modules:/workspace/node_modules" \
  -v "$VOLUME-target:/root/target" \
  -v remote-exec-dev-cargo-registry:/usr/local/cargo/registry \
  "$IMAGE" "$@"
