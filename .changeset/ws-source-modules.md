---
"@cloudflare/computer": minor
---

`WorkerJavaScriptBackend` accepts source modules under simple `ws:*` names, for a library the host provides, such as one that wraps host modules in objects. Source modules under `ws:*` can import each other and the host modules by name.
