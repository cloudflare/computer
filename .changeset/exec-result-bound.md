---
"@cloudflare/computer": patch
---

Bound the `exec` tool's `result` for the model. A callable backend's return value past the output limit is saved to a file in the Workspace output directory, and `result` carries its path, size and a preview.
