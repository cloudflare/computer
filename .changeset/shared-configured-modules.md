---
"@cloudflare/computer": patch
---

Install each Worker JavaScript configured module once per execution and share it across importing directories, instead of copying it into every directory. Large configured modules no longer multiply the Loader graph or load as separate instances.
