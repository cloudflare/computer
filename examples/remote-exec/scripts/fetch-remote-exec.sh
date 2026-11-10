#!/usr/bin/env bash
# Puts the x86_64 remote-exec build at bin/remote-exec, which wrangler.jsonc's rules upload as its
# own module, so src/index.ts streams it from /bundle into the container. Only x86_64: wrangler dev
# builds the image for linux/amd64, as Cloudflare runs it. Uses the repository's own build in
# artifacts/remote-exec when it's there (`npm run build:bin --workspace @cloudflare/remote-exec`, or
# CI's), and otherwise downloads it from the @cloudflare/computer GitHub release matching the
# installed package, checking it against the release's SHA256SUMS. REMOTE_EXEC_VERSION picks
# another release.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bin
FILE=remote-exec-linux-x86_64

local_build=../../artifacts/remote-exec/$FILE
if [ -f "$local_build" ]; then
  cp "$local_build" bin/remote-exec
  echo "remote-exec: copied $local_build"
  exit 0
fi

version="${REMOTE_EXEC_VERSION:-$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const pkg = new URL("../package.json", import.meta.resolve("@cloudflare/computer"));
  console.log(JSON.parse(readFileSync(pkg, "utf8")).version);
')}"
release="https://github.com/cloudflare/computer/releases/download/%40cloudflare%2Fcomputer%40$version"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for file in SHA256SUMS "$FILE"; do
  curl -fsSL --retry 3 -o "$tmp/$file" "$release/$file"
done
# Only this build's line: the release lists the others too.
grep -E " \*?$FILE\$" "$tmp/SHA256SUMS" > "$tmp/SUM" ||
  { echo "remote-exec: $FILE isn't in the release's SHA256SUMS" >&2; exit 1; }
if command -v sha256sum >/dev/null; then
  (cd "$tmp" && sha256sum -c SUM)
else
  (cd "$tmp" && shasum -a 256 -c SUM)
fi
cp "$tmp/$FILE" bin/remote-exec
echo "remote-exec: downloaded $FILE from @cloudflare/computer@$version"
