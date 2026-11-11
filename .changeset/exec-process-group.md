---
"@cloudflare/computerd": patch
---

`killExec`, timeouts and disposal stop a command's whole process group, not just its shell, and a slow reader no longer holds back the exit. See [Lifecycle differences](https://github.com/cloudflare/computer/blob/main/docs/05_runtime_interface.md#lifecycle-differences).
