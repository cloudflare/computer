---
"@cloudflare/computer": patch
---

Add `workspace.runtime.backends()`, which lists each backend's id, protocol, whether it is callable, and its description for a model, including the modules a `WorkerJavaScriptBackend` can import; see [backend routing documentation](https://github.com/cloudflare/computer/blob/main/docs/05_runtime_interface.md#backend-routing).
