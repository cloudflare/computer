---
"@cloudflare/computer": patch
---

Workspaces take passthrough mounts, whose files are never stored: every read under the root is answered live by the mount, and writes fail with `EROFS`. See [Passthrough](https://github.com/cloudflare/computer/blob/main/docs/06_mount_interface.md#passthrough).
