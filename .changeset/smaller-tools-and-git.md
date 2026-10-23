---
"@cloudflare/computer": patch
---

The Git entrypoint hashes with `node:crypto` instead of bundling `sha.js` and its Buffer polyfills, which trims about 120 KB from a Worker that uses it, and the worker-shell modules are minified, shrinking them by 28%. `@cloudflare/computer/tools` and its `ai-sdk`, `pi-ai` and `tanstack-ai` variants also no longer reference the bundled isomorphic-git, which unbundled loaders such as Node and Vite's dev server used to fetch for them.
