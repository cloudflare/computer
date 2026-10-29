---
"@cloudflare/computer": patch
---

The worker shell no longer double-encodes non-ASCII bytes written by redirected `cat`, heredocs, `tee` and other byte-oriented commands.
