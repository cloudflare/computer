---
"@cloudflare/computerd": minor
---

Add `MOUNT_IGNORE`: paths that stay on the container's local disk

Everything a container command writes under `MOUNT_POINT` was recorded in the
VFS and pulled into the Durable Object after the command. That is right for
source and wrong for `node_modules`, `.venv`, `target/` and `dist/`, where
tens of thousands of rebuildable files never need to be durable.

Set `MOUNT_IGNORE` to a newline-delimited list of paths relative to the mount
root. Matching paths are served from `MOUNT_IGNORE_PATH` (default
`/tmp/$MOUNT_POINT`) instead of the VFS, so they are never recorded, pushed,
or pulled. `/__computerd/info` reports the resolved set.

The trade-off is deliberate: local-only content is invisible to `workspace.fs`
and the worker shell, and survives container replacement only through a
snapshot. A rename across the boundary returns `EXDEV` rather than being
silently turned into a non-atomic copy.
