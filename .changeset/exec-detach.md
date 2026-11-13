---
"@cloudflare/computer": patch
---

The `exec` tool takes an experimental `detach: true`, or `{ afterMs }`, that returns once a run waits for an answer, or has gone on that long, with its `executionId` and output so far, and leaves it running for its backend's `onDetachedExit`; see [Detaching](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#detaching).
