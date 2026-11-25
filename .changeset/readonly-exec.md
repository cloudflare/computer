---
"@cloudflare/computer": patch
---

A `readonly: true` tool set offers `exec` on backends that can't change the Workspace, such as a `CodemodeBackend` with `access: "read"`, which `runtime.backends()` now reports as `access`.
