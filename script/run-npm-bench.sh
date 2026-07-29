#!/usr/bin/env bash
# Runs npm-bench.sh inside a privileged Docker container with computerd mounted.
# with computerd mounted, comparing npm install speed on native disk vs the
# FUSE mount. Boot computerd, run the bench, and drop the results on the host.
#
# Usage:
#   script/run-npm-bench.sh
#
# Knobs (environment variables):
#   COMPUTERD_BINARY      path to the computerd linux-x64 binary
#                   (default: artifacts/computerd/computerd-linux-x64)
#   REPS            number of timed repetitions (default: 3)
#   WARMUP          number of warm-up runs that are not counted (default: 1)
#   OUTPUT_JSON     host path where the JSON result file is written
#                   (default: bench-out/npm-bench.json)
#   SCENARIOS       comma-separated list of scenarios to run
#                   (default: express)
#   FUSE_TRACE      set to "summary" to capture a FUSE op trace per run
#
# Requirements:
#   docker          available and able to run --privileged containers
#   computerd linux-x64 binary at COMPUTERD_BINARY
#
# The binary is built with:
#   npm run build:bin --workspace @cloudflare/computerd
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

COMPUTERD_BINARY="${COMPUTERD_BINARY:-$REPO_ROOT/artifacts/computerd/computerd-linux-x64}"
OUTPUT_JSON="${OUTPUT_JSON:-$REPO_ROOT/bench-out/npm-bench.json}"
REPS="${REPS:-3}"
WARMUP="${WARMUP:-1}"
SCENARIOS="${SCENARIOS:-express}"
FUSE_TRACE="${FUSE_TRACE:-}"

if [ ! -f "$COMPUTERD_BINARY" ]; then
  echo "computerd binary not found at $COMPUTERD_BINARY"
  echo "Build it with: npm run build:bin --workspace @cloudflare/computerd"
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_JSON")"

docker run --rm --platform linux/amd64 --privileged \
  --device /dev/fuse --cap-add SYS_ADMIN --cap-add MKNOD \
  -v "$COMPUTERD_BINARY:/usr/local/bin/computerd:ro" \
  -v "$SCRIPT_DIR/npm-bench.sh:/usr/local/bin/npm-bench:ro" \
  -v "$SCRIPT_DIR/run-npm-bench-inner.sh:/run-bench.sh:ro" \
  -v "$(dirname "$OUTPUT_JSON"):/out" \
  -e "REPS=$REPS" \
  -e "WARMUP=$WARMUP" \
  -e "SCENARIOS=$SCENARIOS" \
  -e "OUTPUT_JSON=/out/$(basename "$OUTPUT_JSON")" \
  -e "COMPUTERD_FUSE_TRACE=${FUSE_TRACE}" \
  debian:stable-slim bash /run-bench.sh
