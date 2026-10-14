---
"@cloudflare/computer": minor
---

`just-bash` is now an optional peer dependency, so install it yourself if you use `@cloudflare/computer/backends/worker-shell`. `acorn` is no longer installed with the package, because the JavaScript backend already bundles it.
