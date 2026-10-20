---
"@cloudflare/computer": minor
---

Add the experimental `DynamicJavaScriptBackend` at `@cloudflare/computer/backends/dynamic-javascript`. It runs code like `WorkerJavaScriptBackend`, and runs a Workspace file whose default export extends `DurableObject` as a long-lived app: importing the file gives `ctx.facets` for that app, with `get`, `abort`, `delete` and `clone`, and each instance's methods run in a Durable Object facet with its own storage.
