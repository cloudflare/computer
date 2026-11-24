---
"@cloudflare/computer": patch
---

Commands run with an `outbound` now get the egress CA's environment variables, so npm, pnpm and Node scripts trust the routed container's HTTPS instead of failing with `SELF_SIGNED_CERT_IN_CHAIN`.
