---
"@cloudflare/computer": patch
---

`WorkerJavaScriptBackend` passes `node:fs` and host module calls between the isolate and the Durable Object as real Workers RPC values instead of JSON text with a custom byte encoding. Byte arrays now count at their real size against `maxCapabilityBytes`, so a 900-byte write fits under a 1024-byte limit where it used to be rejected. Every call still goes through one host bridge that enforces call counts, concurrency, deadlines, and byte budgets, and it now rejects functions, RPC stubs, and cycles in a request before the host acts on it.
