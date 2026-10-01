---
"@cloudflare/computer": minor
---

Add `ignore` to `CloudflareContainerBackend`: assert the container's local-only paths

`CloudflareContainerBackend` now reads the container's local-only path set
from `/__computerd/info` and exposes it as `handle.ignore`.

Pass `ignore` to declare which paths the image is expected to keep on local
disk. `connect()` rejects when the container disagrees, including when it
predates the feature entirely — an image built without `MOUNT_IGNORE`
otherwise looks identical to a correct one until a large dependency tree is
written and pulled into the Durable Object.

The option is a declaration, not a setting: the set belongs to the image,
which reads `MOUNT_IGNORE` at startup. Omitting `ignore` accepts whatever the
container provides, so existing deployments are unaffected.
