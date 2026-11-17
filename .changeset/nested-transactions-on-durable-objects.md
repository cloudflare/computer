---
"@cloudflare/dofs": patch
---

Nested `transactionSync` calls on a `Database` now work on Durable Object storage, which rejects the SAVEPOINT statements they used to issue.
