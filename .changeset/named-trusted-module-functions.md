---
"@cloudflare/computer": minor
---

Trusted modules now export named functions. Pass `trustedModules: { "ws:container": { exec } }` and caller code writes `import { exec } from "ws:container"`. Each host function receives `(args, { signal, deadline })`.

This replaces the single `call(method, args, context)` handler and the generic `call` export. Move each method into its own function: `{ call(method, args) { if (method === "batch") ... } }` becomes `{ batch(args, context) { ... } }`, and `call("batch", requests)` in caller code becomes `batch(requests)`. The backend now rejects a bad specifier or export name at construction instead of at the first execution.
