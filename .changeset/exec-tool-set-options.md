---
"@cloudflare/computer": minor
---

The tool sets' `exec` option now takes `{ backends, output, metadata }`. Change `exec: { id: {...} }` to `exec: { backends: { id: {...} } }`, `execOutput: {...}` to `exec: { output: {...} }`, and `exec: {}` for no exec tool to `exec: { backends: {} }`; an old backend map or `exec: {}` now throws.
