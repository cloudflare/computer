---
"@cloudflare/computer": patch
---

`container-shell` operations now reconnect after computerd restarts when retrying is safe, and process-local execution handles return `EEXEC_LOST` after container replacement. See [container connection recovery](https://github.com/cloudflare/computer/blob/main/docs/05_runtime_interface.md#command-synchronization).
