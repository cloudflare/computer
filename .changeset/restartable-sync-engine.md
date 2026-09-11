---
"@cloudflare/computer": minor
---

Synchronization now runs as a durable, restartable operation. A pull or push opens an operation row that fixes the target revision, records the cursor it has reached, and survives eviction, so an interrupted transfer resumes from its watermark instead of starting again. `pull()` and `push()` are async iterables: each step moves one cursor-bounded block, and a caller that stops iterating simply stops the transfer.

Large cursor windows now travel as a single gzip change pack that interleaves entries with the objects they reference, replacing the entry stream and its `hasObjects` / `fetchObjects` round trips. The `fetchChangePack` and `applyChangePack` wire methods are optional, and a peer that lacks them falls back to entry mode, so the two sides can be deployed in either order.

The batch synchronization API and the retry scheduler are removed rather than deprecated. `SyncBatchOptions`, `SyncBatchBudget`, `SyncBatchResult`, `SyncRetryScheduler`, `SyncRetryIntent`, `SyncRetryOptions`, and `WorkspaceRetryPendingSyncResult` are no longer exported, the `retryScheduler` option is gone from `Workspace`, and `retryPendingSync()` is deleted. The operation row and the watermark now hold the state those existed to persist, so a caller that previously scheduled a retry from its own alarm can drop that code and call `pull()` instead. Attempt counts, backoff, and exhaustion are no longer part of the surface.
