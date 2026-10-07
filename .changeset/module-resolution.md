---
"@cloudflare/computer": minor
---

`WorkerJavaScriptBackend` stores each configured source and host module once and resolves every import of it by name, instead of copying it into every directory the caller's code uses. A large bundle imported from several directories no longer counts against `maxSourceBytes` once per directory, and every importer shares one instance of it. Absolute imports such as `/workspace/lib/util.js` now work, confined to the backend root like relative ones. Imports resolve the same way with and without the `new_module_registry` compatibility flag; previously, `ws:*` imports failed under the new registry.

A source module may import other source modules, host modules, and built-in modules, but no longer Workspace files. Such an import only resolved when the caller happened to import the same file from the same directory, and now fails before the Worker is created, naming the module.
