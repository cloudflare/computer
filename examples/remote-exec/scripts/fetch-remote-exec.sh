#!/usr/bin/env bash
# Puts both remote-exec builds in bin/ as remote-exec-linux-<arch>.bin, which src/index.ts imports
# as bytes. Uses the repository's own builds in artifacts/remote-exec when they're there (`npm run
# build:bin --workspace @cloudflare/remote-exec`, or CI's), and otherwise downloads them from the
# @cloudflare/computer GitHub release matching the installed package, checking their SHA-256 sums.
# REMOTE_EXEC_VERSION picks another release.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bin
ARCHES=(x86_64 aarch64)

local_builds=../../artifacts/remote-exec
if [ -f "$local_builds/remote-exec-linux-x86_64" ] && [ -f "$local_builds/remote-exec-linux-aarch64" ]; then
  for arch in "${ARCHES[@]}"; do
    cp "$local_builds/remote-exec-linux-$arch" "bin/remote-exec-linux-$arch.bin"
  done
  echo "remote-exec: copied the builds in $local_builds"
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
for file in SHA256SUMS "${ARCHES[@]/#/remote-exec-linux-}"; do
  curl -fsSL --retry 3 -o "$tmp/$file" "$release/$file"
done
(cd "$tmp" && shasum -a 256 -c SHA256SUMS)
for arch in "${ARCHES[@]}"; do
  cp "$tmp/remote-exec-linux-$arch" "bin/remote-exec-linux-$arch.bin"
done
echo "remote-exec: downloaded the builds from @cloudflare/computer@$version"
