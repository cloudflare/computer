---
"@cloudflare/computer": patch
"@cloudflare/dofs": patch
---

Mounts can now declare a `version`, a string or an async function, stored under `_vfs_mounts.version` (schema v10), and every index clears the mount root first; see [mount documentation](https://github.com/cloudflare/computer/blob/main/docs/06_mount_interface.md#versions).
