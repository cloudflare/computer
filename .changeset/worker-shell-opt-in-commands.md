---
"@cloudflare/computer": minor
---

Make worker-shell commands opt-in to cut the deployed bundle. The shell now ships an always-on core plus one optional group per heavy command. Import the groups you want from `@cloudflare/computer/shell/<feature>` and pass them to `WorkerShellBackend`'s new `commands` option; a group you never import is dropped from your Worker upload. This is a breaking change: commands such as `curl`, `python`, `sqlite`, `html-to-markdown`, `js-exec`, `yq`, `file`, `xan`, and `jq` no longer ship unless their group is imported.
