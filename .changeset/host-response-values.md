---
"@cloudflare/computer": patch
---

A host module call can now return more than 4,096 values, as long as the response fits the backend's byte limits.
