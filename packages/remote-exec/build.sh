#!/usr/bin/env bash
# Build remote-exec: static musl binaries for x86_64 and aarch64, copied to
# artifacts/remote-exec/remote-exec-linux-<arch> at the repository root. Releases build the
# remote-exec image from them and attach them to the @cloudflare/computer GitHub release.
#
#   packages/remote-exec/build.sh          # release builds for both architectures
#   packages/remote-exec/build.sh --dev    # debug build for the host only, for the Node tests
#
# Needs: rustup with both musl targets (`rustup target add x86_64-unknown-linux-musl
# aarch64-unknown-linux-musl`) and capnp. Rust's musl targets are self-contained, so aarch64 links
# with the toolchain's own rust-lld: no cross compiler needed. dev/run.sh has all of it.
# The target directory defaults to packages/remote-exec/target; set CARGO_TARGET_DIR to move it.
set -euo pipefail
cd "$(dirname "$0")"
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
OUT=../../artifacts/remote-exec

if [ "${1:-}" = "--dev" ]; then
  cargo build
  echo "$CARGO_TARGET_DIR/debug/remote-exec"
  exit 0
fi

mkdir -p "$OUT"
cargo build --release --locked --target x86_64-unknown-linux-musl
cp "$CARGO_TARGET_DIR/x86_64-unknown-linux-musl/release/remote-exec" "$OUT/remote-exec-linux-x86_64"

CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld \
  cargo build --release --locked --target aarch64-unknown-linux-musl
cp "$CARGO_TARGET_DIR/aarch64-unknown-linux-musl/release/remote-exec" "$OUT/remote-exec-linux-aarch64"

ls -l "$OUT"
