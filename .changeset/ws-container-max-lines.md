---
"@cloudflare/computer": patch
---

`createContainerModule({ maxOutputLines })` limits each `ws:container` stream by lines as well as bytes; see [`ws:container` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wscontainer).
