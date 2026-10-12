---
"@cloudflare/computer": patch
---

`ws:container` keeps the end of each stream, up to `maxOutputLines` and `maxOutputBytes`, when a Workspace with `output: false` returns output whole, rather than its first `maxOutputBytes`; see [`ws:container` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wscontainer).
