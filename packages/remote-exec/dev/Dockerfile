# syntax=docker/dockerfile:1
# Node, Rust with both musl targets, and capnp: everything to build remote-exec and run its
# Linux-only test suites from any machine with Docker (run.sh).
#
# Behind a TLS-inspecting proxy, pass its root certificate, which the image then trusts:
# `docker build --secret id=ca,src=$NODE_EXTRA_CA_CERTS`.
FROM node:24-bookworm

RUN --mount=type=secret,id=ca,required=false \
  if [ -f /run/secrets/ca ]; then \
    cp /run/secrets/ca /usr/local/share/ca-certificates/extra.crt && update-ca-certificates; \
  fi
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

RUN apt-get update \
  && apt-get install -y --no-install-recommends capnproto jq procps \
  && rm -rf /var/lib/apt/lists/*

# run.sh passes the channel from ../rust-toolchain.toml, so the image has the toolchain cargo picks
# there instead of downloading it on every run.
ARG RUST_TOOLCHAIN=stable
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
    --default-toolchain "$RUST_TOOLCHAIN" \
    --target x86_64-unknown-linux-musl --target aarch64-unknown-linux-musl \
  && rustup component add rustfmt clippy \
  && chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME"

# Off the bind-mounted checkout, which is slow on macOS.
ENV CARGO_TARGET_DIR=/root/target
WORKDIR /workspace
CMD ["sleep", "infinity"]
