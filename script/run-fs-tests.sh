#!/usr/bin/env bash
# Non-interactive harness for ./script/shell. Mount the computerd binary, fs-tests,
# and this script into a debian:stable-slim container, then invoke this as
# the entrypoint. computerd runs in the background; fs-tests is executed against
# the FUSE mount; the computerd process is shut down before the script exits with
# fs-tests' status code.
set -u
apt-get update >/dev/null 2>&1
apt-get install -y --no-install-recommends fuse3 libfuse2t64 attr util-linux coreutils findutils git ca-certificates curl >/dev/null 2>&1

mkdir -p /tmp/workspace
PORT=45678 MOUNT_POINT=/tmp/workspace /usr/local/bin/computerd >/tmp/computerd.log 2>&1 &
COMPUTERD_PID=$!

# Wait for /health
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:45678/health >/dev/null 2>&1; then
    echo "computerd ready after ${i}s"
    break
  fi
  sleep 1
done

if ! kill -0 "$COMPUTERD_PID" 2>/dev/null; then
  echo "computerd died:"
  cat /tmp/computerd.log
  exit 1
fi

MOUNT=/tmp/workspace /usr/local/bin/fs-tests
status=$?

kill "$COMPUTERD_PID" 2>/dev/null
wait "$COMPUTERD_PID" 2>/dev/null
exit $status
