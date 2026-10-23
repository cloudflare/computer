---
"@cloudflare/computer": minor
---

`new Workspace({ storage, namespace })` keeps a Workspace's files in their own tables, so one durable object can hold more than one Workspace. Workspaces without a namespace keep using the existing tables.
