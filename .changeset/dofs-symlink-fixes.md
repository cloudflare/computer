---
"@cloudflare/dofs": patch
---

Fix symlink path resolution and write behavior. Relative symlink targets now resolve from the symlink parent, writes follow symlinked parent directories, and writes to final symlinks update or create the target file instead of storing chunks on the symlink node.
