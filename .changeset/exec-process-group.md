---
"@cloudflare/computerd": patch
---

Run each exec in its own process group so `killExec`, timeouts and disposal stop the whole command rather than only the shell, and keep the output pipes paused while the reader is behind so the exit event is not buried.
