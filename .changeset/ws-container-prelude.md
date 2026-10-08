---
"@cloudflare/computer": patch
---

`createContainerModule({ prelude })` runs shell text such as `set -o pipefail` before each `ws:container` command; see [`ws:container` documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wscontainer).
