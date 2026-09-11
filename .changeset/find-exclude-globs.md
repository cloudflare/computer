---
"@cloudflare/dofs": minor
"@cloudflare/computer": minor
---

`find` accepts `exclude`, a list of glob patterns matched against the same directory-relative path as the inclusion glob. Exclusion is decided first, so it always wins, and an excluded directory is pruned during traversal: neither it nor anything below it is read. `limit` and `offset` apply to the matches that survive. The option travels through `WorkspaceFilesystem`, `WorkspaceFilesystemStub`, and the public find tool.

```ts
const sources = await workspace.fs.find("/workspace", "**/*.ts", {
  exclude: ["node_modules", "node_modules/**", ".git", ".git/**"],
});
```
