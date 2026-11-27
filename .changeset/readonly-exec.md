---
"@cloudflare/computer": patch
---

A `readonly: true` tool set offers `exec` on backends that can't change the Workspace, such as a `CodemodeBackend` with `access: "read"`, which `runtime.backends()` now reports as `access`; see [`exec`](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#exec).
