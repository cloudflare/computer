# Image-only distribution of the computerd-linux-x64 SEA binary.
#
# Build via `npm run build:docker --workspace @cloudflare/computerd`,
# which stages the SEA artifact into ./bin/computerd first and then runs
# `docker build` against this directory. The image isn't meant to be
# run as a service — its sole job is to ship the binary at a known
# path so downstream Dockerfiles can `COPY --from`:
#
#   FROM cloudflare/computer-computerd-linux-x64:0.1.1 AS computerd
#   FROM debian:stable-slim
#   COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
#
# `scratch` keeps the layer count minimal (one layer, ~125 MB binary,
# zero base-image surface). The image has no shell, no libc, nothing
# to invoke; `docker run` on it exits immediately. That's the point.

FROM scratch

COPY bin/computerd /usr/local/bin/computerd

# Documentation only. scratch has no PID 1 capable of execing this,
# so the ENTRYPOINT is informational. Downstream consumers redeclare
# their own ENTRYPOINT in the runtime image.
ENTRYPOINT ["/usr/local/bin/computerd"]
