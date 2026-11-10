---
"@cloudflare/computer": minor
---

Codemode module objects can have fields, promises and byte streams (`field()`, `promised()`, `readable()`, `writable()`), any run can pass an `AbortSignal` to a codemode module, and replayable runs can pass a `ReadableStream`; see [Fields, promises and streams](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#fields-promises-and-streams).
