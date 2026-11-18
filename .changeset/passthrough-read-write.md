---
"@cloudflare/computer": patch
---

Passthrough mounts can be `mode: "read-write"`: writes under the root go to the mount's optional `writeFile`, `mkdir`, `rm`, `rename` and `chmod`, container pulls and git included. See [Passthrough: read-write](https://github.com/cloudflare/computer/blob/main/docs/06_mount_interface.md#passthrough-read-write).
