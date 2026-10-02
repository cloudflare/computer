---
"@cloudflare/computer": patch
---

Add `ignore` to `ContainerBackend`: glob patterns, such as `**/node_modules` and `!/vendor/node_modules`, for paths the container keeps on its own disk instead of syncing.
