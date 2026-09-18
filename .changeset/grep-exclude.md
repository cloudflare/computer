---
"@cloudflare/dofs": minor
"@cloudflare/computer": minor
---

Add an `exclude` option to `fs.grep`, matching `fs.find`

`find` could already prune directories from a traversal but `grep` could not, so
there was no way to search a workspace while skipping `node_modules` — the one
thing callers most often want to skip. The exclusion globs are passed to the
same find walker `grep` already traverses with, so an excluded directory is
pruned before its children are queried rather than being read and filtered.

```ts
const todos = await workspace.fs.grep("TODO", "/", {
  include: "**/*.ts",
  exclude: ["node_modules", "node_modules/**"],
});
```

Exclusion is matched against the same directory-relative path as `include` and
applied first, so an exclusion always wins. As with `find`, name both the
directory and its contents to prune the subtree: `node_modules/**` matches what
is below `node_modules`, not `node_modules` itself. Grepping a single file
ignores `exclude`, since the caller named the file and there is no traversal to
prune.
