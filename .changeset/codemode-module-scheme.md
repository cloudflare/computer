---
"@cloudflare/computer": patch
---

`CodemodeBackend` takes a `scheme`, such as `"agent"`, to serve host modules and the host's libraries as `agent:*` instead of `codemode:*`, and `createBrowserModule()` takes `specifier` and `toolsSpecifier` for the names its description gives. See [Module scheme](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#module-scheme).
