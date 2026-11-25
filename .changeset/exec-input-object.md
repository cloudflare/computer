---
"@cloudflare/computer": patch
---

The `exec` tool declares `input` as a plain object, with no `$ref` into a definitions section, and still checks its values are JSON.
