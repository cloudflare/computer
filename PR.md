# Add `exclude` to `fs.grep`

`find` could prune directories from a traversal but `grep` could not, so there
was no way to search a workspace while skipping `node_modules` — the one thing
callers most often want to skip. `include` could name what you wanted; nothing
named what you didn't.

`grep` already walks via find's `iterateFoundEntries`, which has accepted
exclusion globs since `find` gained them. This passes them through, so an
excluded directory is pruned before its children are queried rather than being
read and then filtered.

## Usage

Skip vendored code. Name both the directory and its contents:

```ts
await fs.grep("TODO", "/workspace", {
  exclude: ["node_modules", "node_modules/**"],
});
```

Combine with `include` — exclusion is applied first, so it always wins:

```ts
await fs.grep("TODO", "/workspace", {
  include: "**/*.ts",
  exclude: ["**/*.test.ts"],
});
```

Several subtrees at once:

```ts
await fs.grep("deprecated", "/workspace", {
  exclude: ["node_modules", "node_modules/**", "dist", "dist/**"],
});
```

Same option on the agent-facing tool, matching the one `find` already exposes:

```jsonc
{ "path": "/workspace", "query": "TODO",
  "include": "**/*.ts", "exclude": ["node_modules/**"] }
```

## Semantics

Globs match the directory-relative path, exactly as `include` does, and
exclusion is applied before inclusion.

**Name both forms to prune a subtree.** `node_modules/**` matches what is
*below* `node_modules`, not `node_modules` itself, so on its own the walker
still descends and excludes each child one at a time. `["node_modules",
"node_modules/**"]` prunes the directory outright. This follows `find`, whose
own tests pass both forms; it is a pre-existing sharp edge shared with `find`,
not something introduced here.

To match at any depth rather than only the search root, lead with `**/`:
`["**/node_modules", "**/node_modules/**"]`.

Grepping a single file ignores `exclude` — the caller named the file, so there
is no traversal to prune.

## Tests

39/39 on `grep.test.ts` + `find.test.ts`, 652/652 across dofs. No new typecheck
errors (3 before, 3 after, all pre-existing). Biome clean.

The pruning test asserts *query count*, not just results: filtering after the
walk would return identical matches while still paying for the excluded tree.
Writing it first with only `vendor/**` showed 3 child queries instead of 2,
which is what pinned down the both-forms requirement above.

## Note on target branch

This targets upstream `main`, where `find`'s `exclude` is glob-based. The
`perf` branch already implements `grep.exclude` with *incompatible* semantics —
a `Set` of whole-segment names (`exclude.has(child.name)`), where
`["node_modules"]` prunes at any depth and `node_modules/**` does nothing. It
also carries an inode/size fast path that avoids re-resolving each file, which
merging this naively would delete. Don't merge onto `perf` without reworking.
