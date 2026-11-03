---
"@cloudflare/computer": minor
---

Add `createCodemodeModule()` for host modules that return objects with methods and give their functions shared context. `define(kind, build)` makes objects whose methods are host calls, journaled like any other, and that keep working after a pause or a restart because the backend rebuilds them from their saved state. `context(name, create)` adds a value to `ctx`, made once per connection, or with `{ scoped: true }` once per scope of a run, the first time a method reads it, and disposed when the scope ends. In runs that don't replay, codemode modules can also take callbacks and return streams and live stubs. Codemode modules are experimental.
