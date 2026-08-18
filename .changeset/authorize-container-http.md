---
"@cloudflare/computer": minor
---

The container's HTTP surface now requires a bearer token. The host generates a secret, passes it to the container as RPC_CLIENT_SECRET at launch, and sends it on /connect. Readiness at /health stays open, and leaving the variable unset disables the checks. Before opening a session the host checks that the container refuses an unauthenticated request and fails the connect if it does not, so a container or image predating this has to be recycled. The container's dial-back to the host carries the same secret, and the host refuses an upgrade that does not present it.
