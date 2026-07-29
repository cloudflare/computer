#!/usr/bin/env bash
# Boots a computerd container under FUSE and prints the host URL.
#
# Used by the vitest harness to give TestBackend a
# real computerd to talk to. The harness sets COMPUTERD_HARNESS_URL from
# this script's stdout, then runs the workerd-backed test
# against the URL.
#
# Exit codes:
#   0   Container is up; URL is on stdout (single line, no
#       trailing newline).
#   1   Docker is unavailable or refused to start; stderr
#       carries the failure.
#
# Teardown is the caller's responsibility — track the container
# id from `docker run` and `docker kill` it. We print it on
# stderr for the harness to capture.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BINARY="${COMPUTERD_BINARY:-$ROOT/artifacts/computerd/computerd-linux-x64}"
HOST_PORT="${COMPUTERD_HARNESS_PORT:-0}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found in PATH" >&2
  exit 1
fi

if [[ ! -x "$BINARY" ]]; then
  echo "computerd binary not found at $BINARY" >&2
  echo "Run 'npm run build:bin --workspace @cloudflare/computerd' first" >&2
  exit 1
fi

# Pre-pull the libfuse2 packages once per container by using
# our own intermediate image. Skipped if the image already
# exists.
IMAGE_TAG="computerd-harness:libfuse2"
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "building $IMAGE_TAG..." >&2
  docker build --platform linux/amd64 -t "$IMAGE_TAG" - <<'DOCKERFILE' >&2
FROM --platform=linux/amd64 debian:stable-slim
RUN apt-get update >/dev/null \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 attr util-linux coreutils findutils \
      >/dev/null \
 && rm -rf /var/lib/apt/lists/*
DOCKERFILE
fi

# Boot the container. Privileged + /dev/fuse + SYS_ADMIN is
# the same recipe as script/fs-tests.sh; lets fuse-native
# actually mount.
CID=$(docker run --rm -d \
  --platform linux/amd64 \
  --privileged \
  --device /dev/fuse \
  --cap-add SYS_ADMIN --cap-add MKNOD \
  --security-opt apparmor=unconfined \
  --security-opt seccomp=unconfined \
  -v "$BINARY:/usr/local/bin/computerd:ro" \
  -p "$HOST_PORT:8080" \
  -e PORT=8080 \
  -e MOUNT_POINT=/workspace \
  "$IMAGE_TAG" \
  /usr/local/bin/computerd)

# Report the container id on stderr so the caller can kill it.
echo "COMPUTERD_HARNESS_CID=$CID" >&2

# Resolve the host port. With -p 0:8080 docker maps a random
# ephemeral port; we read it from `docker port`.
HOST_BOUND_PORT=$(docker port "$CID" 8080/tcp | head -1 | awk -F: '{print $NF}')
if [[ -z "$HOST_BOUND_PORT" ]]; then
  echo "failed to resolve host port" >&2
  docker logs "$CID" >&2 || true
  docker kill "$CID" >/dev/null 2>&1 || true
  exit 1
fi

URL="http://127.0.0.1:$HOST_BOUND_PORT"

# Wait for /health. computerd takes a couple of seconds in the
# container because it has to load the experimental SQLite
# binding and bind FUSE.
for _ in $(seq 1 60); do
  if curl -sf "$URL/health" >/dev/null 2>&1; then
    printf '%s' "$URL"
    exit 0
  fi
  sleep 0.5
done

echo "computerd did not become healthy at $URL" >&2
docker logs "$CID" >&2 || true
docker kill "$CID" >/dev/null 2>&1 || true
exit 1
