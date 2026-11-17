---
"@cloudflare/computer": patch
---

Overwriting or removing a file now frees the chunks and manifests nothing else uses, in the same write, so workspace storage no longer grows with every save.
