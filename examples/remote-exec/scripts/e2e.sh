#!/usr/bin/env bash
# The example end to end, in Docker: starts `wrangler dev`, runs the cctr tests in test/ against
# it, and stops it. Extra arguments go to cctr (e.g. `-v`, `-p abort`). Needs @cloudflare/computer
# built (`npm run build`), Docker and cctr. The remote-exec builds come from
# scripts/fetch-remote-exec.sh: the repository's own when there are some, otherwise the release's.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8799}"
scripts/fetch-remote-exec.sh
LOG="$(mktemp -t remote-exec-dev.XXXXXX)"
npx wrangler dev --port "$PORT" --ip 127.0.0.1 >"$LOG" 2>&1 &
WRANGLER=$!
# wrangler leaves the containers' network sidecars running, and enough of them exhaust Docker's
# kernel keyring, after which no container starts.
cleanup() {
  kill $WRANGLER 2>/dev/null
  wait $WRANGLER 2>/dev/null || true
  docker ps -q --filter name=workerd-computer-remote-exec-example- | xargs -r docker rm -f >/dev/null
}
trap cleanup EXIT
until grep -q "Ready on" "$LOG"; do
  if ! kill -0 $WRANGLER 2>/dev/null; then
    cat "$LOG"
    exit 1
  fi
  sleep 1
done
BASE="http://127.0.0.1:$PORT" PATH="$PWD/test/bin:$PATH" cctr test "$@"
