#!/usr/bin/env bash
# Inner entrypoint for the npm-bench Docker container; not called directly. Installs
# dependencies, starts computerd, and runs npm-bench.sh. Not meant to be
# called directly — run-npm-bench.sh is the user-facing entry point.
set -u

apt-get update >/dev/null 2>&1
apt-get install -y --no-install-recommends \
  fuse3 libfuse2t64 attr util-linux coreutils findutils \
  ca-certificates curl nodejs npm >/dev/null 2>&1

mkdir -p /tmp/workspace /tmp/baseline

COMPUTERD_FUSE_TRACE="${COMPUTERD_FUSE_TRACE:-}" \
  COMPUTERD_FUSE_TRACE_FILE="${COMPUTERD_FUSE_TRACE_FILE:-}" \
  PORT=45678 MOUNT_POINT=/tmp/workspace /usr/local/bin/computerd >/tmp/computerd.log 2>&1 &
COMPUTERD_PID=$!

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

MOUNT=/tmp/workspace BASE=/tmp/baseline /usr/local/bin/npm-bench
status=$?

kill -USR2 "$COMPUTERD_PID" 2>/dev/null && sleep 1
kill "$COMPUTERD_PID" 2>/dev/null
wait "$COMPUTERD_PID" 2>/dev/null
exit $status
