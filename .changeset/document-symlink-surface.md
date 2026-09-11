---
"@cloudflare/computer": patch
---

Document the symbolic-link filesystem surface. `docs/04_filesystem_interface.md` claimed that symbolic links were internal and that `Workspace.fs` had no `symlink`, `readlink`, `lstat`, or `chmod`, none of which matched the shipped API. Those four methods now have sections of their own covering return values and the `ENOENT`, `EINVAL`, and `ELOOP` cases, the comparison with `node:fs/promises` maps them, and the specification explains that `stat` follows a trailing link while `lstat` reports the link itself.
