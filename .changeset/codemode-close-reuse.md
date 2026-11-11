---
"@cloudflare/computer": patch
---

A codemode run no longer starts again when the Workspace is used while `close()` is still cancelling it. See [Isolation and lifecycle](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#isolation-and-lifecycle).
