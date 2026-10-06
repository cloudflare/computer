---
"@cloudflare/computer": patch
---

Long command output is now cut and saved to a file by default, the way pi's bash tool does it. A stream longer than 2000 lines or 64 KiB comes back from `result()` as its last 2000 lines or 64 KiB, and its full output is saved byte for byte to `/.computer/output/<backend>.<id>.stdout.log` (or `.stderr.log`). `result.truncated` and the `exit` event say which streams were cut and where each was saved. Only a window of the end is held in memory, so a command that prints hundreds of megabytes no longer fills the Durable Object's memory.

Set the limits, directory, and how many files to keep (newest 50) with `new Workspace({ output })`, override the limits per run with `runtime.exec(..., { output })`, or pass `output: false` to keep all output as before.

The `exec` tool uses the same defaults and shows the end of long output with a note naming the saved file, for example `[Showing lines 1001-3000 of 3000. Full output: /.computer/output/shell.exec-1.stdout.log]`. Its `maxBytes` still defaults to 64 KiB, it takes `maxLines`, and `streamMaxBytes` is ignored.
