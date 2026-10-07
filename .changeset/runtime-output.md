---
"@cloudflare/computer": minor
---

`runtime.exec` results keep only the last 2000 lines or 64 KiB of each stream and save the full output to a Workspace file, configured with `new Workspace({ output })` or turned off with `output: false`; see [long output documentation](https://github.com/cloudflare/computer/blob/main/docs/05_runtime_interface.md#long-output).
