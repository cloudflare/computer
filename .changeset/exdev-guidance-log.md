---
"@cloudflare/computerd": patch
---

Log actionable guidance on the first cross-boundary rename

A rename between a `MOUNT_IGNORE` path and a synced one returns `EXDEV`,
which reaches the caller as `cross-device link` — an unhelpful message on a
path that is plainly not a device.

computerd now logs once per mount naming both sides, why the rename cannot be
atomic, and the entry to add to `MOUNT_IGNORE` to make it atomic. Build tools
that stage into a sibling directory and rename into place are the common
cause, and the fix is almost always to ignore the staging path too.

Once per mount rather than per rename: a build that does this does it in a
loop.
