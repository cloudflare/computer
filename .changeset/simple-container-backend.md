---
"@cloudflare/computer": minor
---

Add `SimpleContainerBackend`, a container with its own disk and no filesystem sync, and `push` and `pull` in `ws:container` to copy files in and out of it. A pull refuses, with `FileTransferConflictError`, to overwrite a file the Workspace changed since it was last pushed or pulled, unless forced; see [`ws:container` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#copying-files-instead-of-syncing-them).
