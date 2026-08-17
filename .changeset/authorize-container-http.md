---
"@cloudflare/computer": minor
---

The container's HTTP surface now requires a bearer token. The host generates a secret, passes it to the container as RPC_CLIENT_SECRET at launch, and sends it on /connect. Readiness at /health stays open, and leaving the variable unset disables the checks.
