#!/usr/bin/env bash
# Wrapper that runs the docker harness vitest project end-to-end.
#
# - Boots the computerd container via run-computerd.sh, exporting the URL into
#   COMPUTERD_HARNESS_URL so the vitest config can wire it into the
#   worker's bindings.
# - Runs vitest against test-harness/vitest config.
# - Kills the container on any exit path, including SIGINT.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$HERE/.." && pwd)"

cleanup() {
  local cid="${COMPUTERD_HARNESS_CID:-}"
  if [[ -n "$cid" ]]; then
    docker kill "$cid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

# Skip when docker is unavailable. The harness vitest project
# also skips in that case; this keeps `npm run test:harness`
# from failing on contributors without Docker.
if ! docker info >/dev/null 2>&1; then
  echo "docker not available; skipping harness" >&2
  cd "$WORKSPACE_ROOT"
  exec npx vitest "${1:-run}" --run --config vitest.config.harness.ts
fi

# Capture the container id from run-computerd.sh's stderr while
# letting the URL on stdout reach $COMPUTERD_HARNESS_URL.
STDERR_FILE="$(mktemp)"
trap 'rm -f "$STDERR_FILE"; cleanup' EXIT
COMPUTERD_HARNESS_URL="$("$HERE/run-computerd.sh" 2>"$STDERR_FILE")"
COMPUTERD_HARNESS_CID="$(grep -oE 'COMPUTERD_HARNESS_CID=[0-9a-f]+' "$STDERR_FILE" | head -1 | cut -d= -f2)"
export COMPUTERD_HARNESS_URL COMPUTERD_HARNESS_CID

echo "harness: computerd at $COMPUTERD_HARNESS_URL (container $COMPUTERD_HARNESS_CID)" >&2

# First positional arg picks the vitest mode (run|bench).
# Default is `run` so the existing scripts keep working.
MODE="${1:-run}"
cd "$WORKSPACE_ROOT"
npx vitest "$MODE" --run --config vitest.config.harness.ts
