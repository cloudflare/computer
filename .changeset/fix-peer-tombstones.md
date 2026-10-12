---
"@cloudflare/dofs": patch
"@cloudflare/computer-rpc": patch
---

Deletes made in the container (`rm`, `mv`) now reach the Durable Object, and pushed deletes reach computerd, instead of being dropped as stale by comparing revisions from two independent counters; tombstones carry a fingerprint of the removed version (schema v9) and a clean pull acknowledges what it applied, so the next push no longer re-sends pulled entries ([replay and idempotency](https://github.com/cloudflare/computer/blob/main/docs/02_sync_protocol.md#replay-and-idempotency)).
