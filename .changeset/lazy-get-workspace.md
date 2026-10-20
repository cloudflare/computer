---
"@cloudflare/computer": minor
---

`getWorkspace()` now returns a lazy client immediately which resolves on the first call. `useThink` and the Think compatibility methods are removed; `@cloudflare/think` 0.21 and later take a `Workspace` as it is.
