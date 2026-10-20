---
"@cloudflare/computer": patch
---

`WorkspaceFileStore` and `WORKSPACE_ROOT` are exported from `@cloudflare/computer`, so code outside the tools can read and write workspace files without its own helper.
