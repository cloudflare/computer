---
"@cloudflare/dofs": patch
"@cloudflare/computer-rpc": patch
---

Deletes made in the container (`rm`, `mv`) now reach the Durable Object, and pushed deletes reach computerd, instead of being dropped as stale by comparing revisions from two independent counters ([replay and idempotency](https://github.com/cloudflare/computer/blob/main/docs/02_sync_protocol.md#replay-and-idempotency)).
