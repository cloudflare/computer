---
"@cloudflare/computer": patch
---

`ws:container`'s `exec` also returns `sync: { status, skipped, skippedCount, error? }`. `status` is `pending` when the container's file changes have not reached the Workspace, and `skipped` lists up to 100 paths the Workspace refused, such as files in a read-only mount, with `skippedCount` giving the full count. The docs now state that the sync is last-writer-wins: the container's changes replace files written in the Workspace while the command runs.
