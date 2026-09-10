---
"@cloudflare/computer": minor
---

CloudflareContainerBackend takes a codemode option. When set, a command inside the container can run codemode < script.js: the script reaches the Durable Object through the existing egress interception at /codemode and runs in a dynamic worker through @cloudflare/codemode, with the connectors you list as typed globals. WorkspaceProxy forwards /codemode to the Durable Object the way it forwards /api. @cloudflare/codemode is a new optional peer dependency, needed only when the option is used.
