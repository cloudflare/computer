---
"@cloudflare/computer": minor
---

Isolate JavaScript can call an agent's own tools through `ws:tools`. `createToolBindings()` from `@cloudflare/computer/modules/tools` builds the module from tool bindings, and `forPiTools()` from `@cloudflare/computer/tools/pi-ai` makes those bindings from pi tools or from `createPiTools()`.
