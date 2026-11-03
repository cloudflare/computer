---
"@cloudflare/computer": minor
---

Add `createScopedModule()` for host modules that hold state for a run, such as a browser session. A scope lasts from when a run's code starts in an isolate until it waits in `ctx.interrupt()` or ends. The backend starts one instance for each scope, on the scope's first call to the module, and closes it when the scope ends, with a `log()` on a run's end that appends to its stderr. Scoped modules are experimental.
