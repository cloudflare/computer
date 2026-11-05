---
"@cloudflare/computer": minor
---

The `exec` tool can start each run with `metadata` for host modules. `createExecTool` takes `metadata` and the tool sets take `exec: { metadata }`: a record of strings, or a function that picks one from the tool call's id. A pi caller can pass `metadata` on the context it hands `execute` instead, which wins.
