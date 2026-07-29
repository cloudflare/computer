#!/usr/bin/env bash
# Non-interactive harness for ./script/shell that runs fs-bench.
# Mount the computerd binary, fs-bench, and this script into a debian
# container, then invoke this as the entrypoint. computerd runs in the
# background; fs-bench is executed against the FUSE mount with a
# /tmp/baseline directory for the computerd-vs-native comparison; the
# computerd process is shut down before the script exits with
# fs-bench's status code.
#
# Mirrors run-fs-tests.sh; differs only in that fs-bench needs
# npm + git for the language-tool scenarios. go is still skipped
# because it's not in debian:stable-slim's apt and pulling the
# binary release would bloat the bootstrap time.
set -u
apt-get update >/dev/null 2>&1
apt-get install -y --no-install-recommends fuse3 libfuse2t64 attr util-linux coreutils findutils git ca-certificates curl npm >/dev/null 2>&1

# /tmp/baseline gives the bench a native target to compare against. The
# previous version forgot to create it, so fs-bench silently dropped the
# baseline column from its output.
mkdir -p /tmp/workspace /tmp/baseline
# Forward optional tracer config to computerd. When COMPUTERD_FUSE_TRACE=summary is
# set the daemon writes a JSON summary on unmount or SIGUSR2; with
# COMPUTERD_FUSE_TRACE_FILE pointed at a host-mounted path the trace survives
# the container.
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

# Forward bench knobs (REPS, WARMUP, RANDOMIZE_TARGETS, OUTPUT_JSON,
# SCENARIOS) into the bench. fs-bench reads them from the environment.
MOUNT=/tmp/workspace BASE=/tmp/baseline /usr/local/bin/fs-bench
status=$?

# Ask computerd to dump the FUSE trace (if enabled) before the SIGTERM. The
# trace handler is async, so give it a moment to land on disk before we
# wait on the process.
kill -USR2 "$COMPUTERD_PID" 2>/dev/null && sleep 1
kill "$COMPUTERD_PID" 2>/dev/null
wait "$COMPUTERD_PID" 2>/dev/null
exit $status
