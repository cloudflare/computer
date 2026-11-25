---
"@cloudflare/computer": patch
---

The `exec` tool takes `id`, which picks each run's id from its tool call's, so a call made again, as a durable agent loop does after a restart, attaches to the run it started instead of starting another; see [Run ids](https://github.com/cloudflare/computer/blob/main/docs/09_tool_interface.md#run-ids). `CodemodeBackend`'s calls by id wait for an exec that's still starting.
