---
"@cloudflare/computer": patch
---

Imports of `ws:*` and other configured modules work when `compatibilityFlags` includes `new_module_registry`; see [module documentation](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#modules).
