---
"@cloudflare/computer": patch
---

A `WorkerJavaScriptBackend` run that returns an object with `undefined` fields now completes with those fields dropped, as `JSON.stringify` does, instead of failing with "must be JSON-compatible values". A cyclic argument to a `node:fs` or host module call now fails with a clear "must be acyclic" error instead of a stack overflow.
