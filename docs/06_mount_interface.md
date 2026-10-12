# Mount Interface

> [!IMPORTANT]
> This document describes the **intended design** and has **diverged
> from the current implementation** in the repository. Names,
> signatures, and behaviours described here are targets, not what
> `main` ships today. When in doubt, treat the code as authoritative
> for what runs and this doc as authoritative for what we're moving
> toward.

A mount populates a subtree of the workspace from an external source —
R2, a GitHub repository, an artifact bundle, or anything custom. Mounts
are configured once at construction and live for the lifetime of the
`Workspace`.

## Configuring mounts

```ts
new Workspace({
  // ...
  mounts: {
    "/workspace/.agents/skills": R2Bucket(env.SHARED_FILES, { prefix: ".agents/skills" }),
    "/workspace/project":        GitHubRepo("cloudflare/agents", { env }),
    "/workspace/scratch":        R2Bucket(env.SCRATCH, { mode: "read-write" }),
  },
});
```

Each key is an absolute *mount root* inside the VFS. Mount roots must
not nest — `/workspace/a` and `/workspace/a/b` together is rejected at
construction.

## Strategies

A mount is either **lazy** or **eager**.

### Lazy

`list()` enumerates the tree; `fetch(relPath)` returns one file's bytes.
The workspace calls `list()` once on first use to insert stubs into
`vfs_nodes`, then calls `fetch()` on demand the first time something
reads a stub.

```ts
interface LazyMount {
  readonly kind: string;
  readonly strategy?: "lazy";
  readonly writable: boolean;
  list():  Promise<MountEntry[]>;
  fetch(relPath: string): Promise<Uint8Array>;
  put?(relPath: string, bytes: Uint8Array): Promise<void>;   // writable only
  delete?(relPath: string): Promise<void>;                   // writable only
}
```

Best when individual files are random-access and individually addressable
(R2, S3, HTTP).

### Eager

`materialize(api)` populates everything in one shot through a small write
API into the VFS. Called once per indexed mount per DO lifetime.

```ts
interface EagerMount {
  readonly kind: string;
  readonly strategy: "eager";
  readonly writable: boolean;
  materialize(api: MountWriteApi): Promise<void>;
  put?(relPath: string, bytes: Uint8Array): Promise<void>;
  delete?(relPath: string): Promise<void>;
}

interface MountWriteApi {
  writeFile(absPath: string, bytes: Uint8Array, mode?: number): void;
  mkdir(absPath: string, mode?: number): void;
}
```

Best when the backing store only produces content as a single transaction
(a git clone yields the whole working tree at once).

## Factories

Mount values in `WorkspaceOptions.mounts` are *factories*:

```ts
type MountFactory = (ctx: MountContext) => Mount;

interface MountContext {
  sessionId: string;        // agent's DO name
  root:      string;        // absolute mount root, no trailing slash
  vfs:       VFS;           // direct VFS handle for fs-shaped consumers
}
```

The factory is called once on first index. This lets per-session mounts
(scoped R2 prefix, per-session git fork) derive their identity from the
session without the caller threading `sessionId` through.

Bare `Mount` objects are also accepted for back-compat.

## Read-only vs read-write

Mounts default to `mode: "read-only"`. Writes anywhere under the mount
root throw `EROFS`, and writes that occur container-side during `exec()`
are dropped on the post-exec pull (after the bytes are received, before
they hit `vfs_nodes`).

Pass `mode: "read-write"` to opt in to write-through. Container-side
writes are mirrored to the mount with bounded concurrency after the
post-exec pull.

### Write-back gating

DO-side writes (`fs.writeFile`, `fs.rm`) are **debounced** before they
hit the provider. A path is held for `writeBackMs` (default 500 ms)
after its last DO-side mutation; only the final state in that window
is mirrored. Burst writes — a build rewriting a manifest a dozen
times, an editor saving on every keystroke — collapse to one `put`.

Two escape hatches for callers that need precise control:

- `workspace.flushMounts(root?)` — force an immediate mirror of any
  pending debounced writes.
- `{ writeBack: "manual" }` on the mount — disables the debounce
  entirely. Writes accumulate in the VFS and only land on the
  provider when `flushMounts()` is called.

Mirror order for a single path's final state:

| Operation | Order |
| --- | --- |
| `fs.writeFile` (debounced) | VFS row first, then mount `put()` once the debounce fires. Failed `put` leaves the VFS row in place and surfaces via the conflict hook. |
| `fs.rm` (file, debounced) | VFS row first, then mount `delete()`. |
| `fs.mkdir` | VFS only (R2-style stores have no directory concept). |
| `exec` writes | pulled into VFS, then mirrored to the mount with bounded concurrency after the post-exec pull. |

## Built-in providers

### `R2Bucket(binding, options?)`

Lazy mount over an R2 bucket binding.

```ts
R2Bucket(env.SHARED_FILES, {
  prefix:   ".agents/skills",   // strip from R2 keys when computing relPaths
  mode:     "read-only",        // or "read-write"
  ignore:   [".cache"],         // mount-scoped; composed with the global ignore
  maxBytes: 1 << 30,            // optional quota; throws at index time if exceeded
});
```

- `list()` issues one R2 `list()` per index.
- `fetch(relPath)` issues one R2 `get()` per stub on first read.
- `put` and `delete` proxy to R2 when `mode: "read-write"`.

### `WorkerBundle(source, options?)`

Eager, read-only mount over files that ship inside the Worker itself.
Use it for files that belong to the deployment, such as skills,
templates, or reference material.

```ts
import { WorkerBundle } from "@cloudflare/computer";

new Workspace({
  // ...
  mounts: {
    "/workspace/.agents/skills": WorkerBundle(skills),
  },
});
```

`source` takes one of three forms, depending on how the Worker is
built:

| `source` | Built with | Where the files come from |
| --- | --- | --- |
| A path, such as `"skills"` | wrangler | A directory under `/bundle`, read with `node:fs`. See [Shipping the files with wrangler](#shipping-the-files-with-wrangler). |
| `{ version, files }`, from `import skills from "computer:bundle/src/skills"` | Vite | Modules generated by `computerBundle()`. See [Shipping the files with Vite](#shipping-the-files-with-vite). |
| A tree, such as an `import.meta.glob` result | Vite, or anything | An object of relative paths to contents (`string` or `Uint8Array`), or to functions that load them. |

The mount is always read-only. Writes under the root through
`Workspace.fs` reject with `EROFS`, and writes from the container are
dropped on pull. There's no `mode` option, because the deployment owns
these files and there is nowhere to write changes back to.

```ts
WorkerBundle(skills, {
  // Skip entries. Skipping a directory skips everything under it.
  filter: ({ path, type }) => !path.startsWith("drafts/"),
  // Bundled files carry no permission bits. By default, files that
  // start with "#!" get 0o755 and everything else 0o644.
  fileMode: (path, bytes) => (path.startsWith("scripts/") ? 0o755 : undefined),
  // See "Versions" below. A string skips hashing; false turns refresh off.
  version: env.CF_VERSION_METADATA.id,
  maxBytes: 10 << 20,
  maxEntries: 5_000,
});
```

- File contents are only read in `materialize()`, which runs on the
  first index and after a version change. A lazy tree's loaders are
  only called then.
- The mount's `version` comes from, in order: the `version` option, the
  version a `{ version, files }` source carries, or a SHA-256 of the
  included paths, file modes and bytes. The hash is computed once per
  isolate, because the bundled files can't change while it's alive. For
  a lazy tree it means loading every file once, so prefer
  `computerBundle()`, which computes the version at build time, or pass
  an explicit `version`.
- `filter` and `fileMode` are often closures over per-session values, so
  a version that depends on them is never shared between mounts. With a
  `filter`, a `{ version, files }` source's version is combined with a
  hash of the selected paths, which needs no file contents. Otherwise,
  and whenever `fileMode` is set, each mount hashes its own selection,
  which costs one hash per durable object start, and for a lazy tree
  means loading every file. Pass an explicit `version` to avoid that.
- When a deploy changes the files, the version changes and each
  workspace replaces its copy on its next index. See
  [Versions](#versions).

#### Shipping the files with wrangler

Pass a path. `WorkerBundle("skills")` reads `/bundle/skills`: with
`nodejs_compat`, workerd exposes every module in the Worker upload as a
read-only file under `/bundle`. An absolute path is read as-is, which
is useful in tests that point at a directory on disk.

Files only appear under `/bundle` with their paths intact when wrangler
uploads each one as its own module. Turn on `find_additional_modules`
and add a rule for the directory. Paths are relative to `base_dir`,
which defaults to the directory of `main`:

```jsonc
// wrangler.jsonc, with "main": "src/index.ts"
"find_additional_modules": true,
"rules": [{ "type": "Data", "globs": ["skills/**/*"], "fallthrough": true }]
```

`src/skills/exec/SKILL.md` then lands at `/bundle/skills/exec/SKILL.md`.
A file imported from code doesn't work: wrangler renames it to a
content hash such as `/bundle/76e042f4…-SKILL.md`. Files inside
`node_modules` aren't uploaded at all.

`WorkerBundle()` checks that the directory exists when it's called, and
throws with the fix in the message if not.

#### Shipping the files with Vite

`@cloudflare/vite-plugin` never puts project files under `/bundle`, and
under `vite dev` the Worker runs through Vite's module runner. So a
Vite project imports the files as code instead. Add `computerBundle()`
from `@cloudflare/computer/vite`:

```ts
// vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { computerBundle } from "@cloudflare/computer/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare(), computerBundle()],
});
```

Then import a directory, relative to the Vite root, and pass it to
`WorkerBundle`. [`examples/vite-bundle`](../examples/vite-bundle) is a
complete project:

```ts
import skills from "computer:bundle/src/skills";

mounts: { "/workspace/.agents/skills": WorkerBundle(skills) }
```

For TypeScript, add `"@cloudflare/computer/vite/client"` to
`compilerOptions.types`, or reference it from a source file:

```ts
/// <reference types="@cloudflare/computer/vite/client" />
```

The plugin turns each `computer:bundle/<dir>` import into a module that
calls Vite's own `import.meta.glob`, plus a version:

```ts
const files = import.meta.glob("./**/*", { base: "/src/skills", query: "?raw", import: "default" });
export default { version: "sha256:…", files };
```

So it behaves the same in `vite dev`, `vite preview` and production:

- Each file is its own module, loaded only when the mount is copied in.
  `vite build` emits one small chunk per file, which wrangler uploads as
  an ES module.
- Editing, adding or removing a file under `vite dev` updates the module
  and its version. A running workspace picks up the new copy on its
  next index, without a restart.
- The version is a hash of the paths and contents, computed by the
  plugin, so the Worker never loads every file just to compare versions.

Limits:

- **Text files only.** `?raw` reads files as UTF-8, so binary files are
  corrupted. Use the wrangler form for those.
- **No dotfiles or `node_modules`.** Like `import.meta.glob`, the plugin
  skips them.
- **Counts toward the script size.** The files are part of the Worker's
  code, which has a size limit.

If you'd rather not add the plugin, you can pass an `import.meta.glob`
result to `WorkerBundle` yourself. The glob has to be written in your
code, with literal arguments:

```ts
const skills = import.meta.glob("./**/*", { base: "./skills", query: "?raw", import: "default" });

mounts: { "/workspace/.agents/skills": WorkerBundle(skills, { version: env.CF_VERSION_METADATA.id }) }
```

Without the plugin there is no build-time version, so pass one, or
`WorkerBundle` loads every file once per isolate to hash them.

### `GitHubRepo(slug, options)`

Eager mount that clones a GitHub repository via `isomorphic-git` and
materializes the working tree into the VFS.

```ts
GitHubRepo("cloudflare/agents", {
  env,                          // for the GITHUB_TOKEN secret
  ref:    "main",               // optional, default "main"
  prefix: "/src/content/docs/", // optional; only this subtree is materialized
});
```

- `materialize()` runs the clone once.
- Currently read-only (no `put`/`delete`).

## Custom mounts

Implement `LazyMount` or `EagerMount`, optionally inside a factory:

```ts
const ArtifactBundle = (id: string): MountFactory => ({ sessionId, root, vfs }: { sessionId: string; root: string; vfs: VFS }) => ({
  kind:      "artifact",
  strategy:  "eager",
  writable:  false,
  async materialize(api) {
    const bundle = await fetchArtifact(id);
    for (const file of bundle.files) {
      api.writeFile(`${root}/${file.path}`, file.bytes, file.mode);
    }
  },
});
```

## Indexing and persistence

On first call to any `fs`, `shell`, or `prefetch` method, every mount
is indexed in parallel. Index state is persisted to `_vfs_mounts`
in SQLite so DO restarts don't trigger a re-list.

### Versions

> [!NOTE]
> This section describes what ships today.

A mount can declare a `version` on `MountBase`: a string, or an async
function that returns one, for sources that can only be versioned by
reading them. The indexer awaits the function before comparing. If it
rejects, that mount fails to index and the others carry on. After a
successful `materialize()`, the indexer records the version in
`_vfs_mounts.version`. On a later boot, it compares that with the
registered mount's `version`:

- **No version on the mount:** the mount is materialized once per store,
  as before. `R2Bucket` works this way.
- **Same version:** the mount is skipped.
- **Different version:** the mount is stale. The indexer removes
  everything under the root, runs `materialize()` again, and records the
  new version.

```text
first boot      → materialize, record "sha256:abc…"
same deploy     → versions match, skip
new deploy      → "sha256:def…" ≠ "sha256:abc…" → rm root, materialize, record "sha256:def…"
```

A mount owns its root. Every index, including the first, removes
everything under the root before `materialize()` runs: files from an
earlier version, files that were there before the mount was registered,
and anything an interrupted run left behind. So a retry after a crash
never keeps stale files, whatever state the crash left
`_vfs_mounts` in. The remove and rewrite go through the workspace
filesystem, so they're recorded as normal changes and reach the
container on its next push. If `materialize()` fails, the root is left
empty with `indexed = 0`, and the next pass tries again.

`WorkerBundle()` sets `version` from a content hash by default, so a
deploy that changes the bundled files refreshes every workspace on its
next index.

`workspace.prefetch(root?)` eagerly hydrates lazy stubs under the given
mount root (or every mount if none supplied). Useful from `onStart` /
`waitUntil` to avoid a cold-start fetch fan-out on the first `grep`.

Concurrent reads of the same stub share one in-flight `fetch()` —
deduped per absolute path.

## Per-mount options

Every mount accepts the following options in addition to its
provider-specific config:

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `"read-only"` | `"read-only"` or `"read-write"`. |
| `ignore` | `[]` | Path segments omitted from the mount's sync pull. The paths remain visible through the underlying `Workspace.fs`; the option is composed with the top-level `ignore` by union. See [02. Sync Protocol → Ignore lists](./02_sync_protocol.md#ignore-lists). |
| `writeBack` | `"debounce"` | `"debounce"` (default) or `"manual"`. See “Write-back gating” above. |
| `writeBackMs` | `500` | Debounce window in milliseconds. Ignored when `writeBack: "manual"`. |
| `maxBytes` | unbounded | Hard cap on total bytes indexed from this mount. Exceeding throws at index time before any data lands in `vfs_nodes`. |
| `maxEntries` | unbounded | Hard cap on entry count. Same enforcement timing as `maxBytes`. |

The workspace-level `ignore` option (the renamed `pullIgnore`) applies
to every mount and to top-level paths. Mount-level `ignore` extends it
for that mount only. No paths are ignored by default.

## Mount conflicts

Two writers can target the same path: a DO-side `fs.writeFile` and a
container-side `exec` that touches the same file. The post-exec pull
applies container-side state to the VFS, then mirrors back out to the
mount. Policy: **container-side state wins** — it ran last,
agentically. The mount is overwritten on mirror.

Callers that want to log or veto the resolution can supply a hook:

```ts
new Workspace({
  onMountConflict: ({ root, relPath, doRev, containerRev }) => {
    // Return `"accept"` (default) or `"keep-do"` to retain the
    // DO-side write and skip the mount mirror for this path.
    return "accept";
  },
});
```

Conflicts on read-only mounts are reported but never mirrored; the
container-side bytes still win inside the VFS, and the read-only
mount stays untouched.

## Limits of laziness

Laziness is **DO-side only**. A lazy mount's `list()` inserts stub
rows into `vfs_nodes` with `manifest_hash NULL`; `fetch(relPath)` is
called on the first DO-side read of that stub, which streams bytes
through the blob / chunk path and promotes the stub to a regular file
row.

The sync protocol ships blobs by hash. A stub row has no blob to
ship, so `pushOnce` cannot deliver a stub to the container. Concretely:

- A container-side read (FUSE) of a path that exists only as a stub
  on the DO sees `ENOENT`. The stub has not been resolved, so there
  is nothing to push.
- `workspace.prefetch(root?)` exists for callers that need a subtree
  fully resolved before handing it to the container. Run it from
  `onStart` / `waitUntil` to avoid a first-`exec` surprise.
- Once a stub is resolved DO-side (by `readFile`, `prefetch`, or any
  other byte-reading path), it ships through sync like any other
  file.

Eager mounts don't have this asymmetry — they materialize at index
time and are visible to the container after the first push.

Demand-pull from the container (FUSE miss → DO fetches the stub →
pushes) and materialize-on-push (resolve stubs while walking the push
queue) are both plausible extensions, but they require new wire
shapes and aren't in scope.

## Mounts are not sync peers

**Non-goal.** Mounts are content sources with an optional
`refresh()` hook, not a third participant in the sync protocol. The
protocol stays a two-peer thing between the DO and the container.

This is deliberate, not an oversight:

- R2 and GitHub have no monotonic rev clock. Treating them as peers
  would force per-tick polling and a diff against a remembered
  snapshot.
- The protocol's invariants — `appliedPushCursor`, watermark
  reconciliation, tombstones — assume one peer. They don't generalize
  to N peers without a real CRDT / LWW story.
- The "container always wins" conflict policy is a deliberate
  hierarchy. Flattening it to treat a mount as a third equal peer
  contradicts the hierarchy.

When a mount needs to pick up upstream changes, call
`workspace.refreshMount(root)`. That's the seam — not a new sync
leg.

## Open questions
These behaviours aren't fully specified yet. File an issue if your use
case depends on a particular resolution.

- **Single-file mounts → file-inside-a-mounted-directory.** A mount
  always covers a subtree today, and the harder version of this
  question isn't “how do I mount one R2 object?” but “what happens if
  a mount root is *itself* nested inside another mount?”
  Construction-time nesting is rejected, but a writable mount whose
  `put()` lands a file at a path that a different mount also claims
  (e.g. via a per-session GitHub mount whose tree contains a
  config.json that another mount also wants to own) needs a defined
  resolution. Likely answer: the mount whose root is the longest
  prefix of the path wins, but the contract hasn't been written.
- **Tear-down hook.** Mounts have `materialize` or `list`/`fetch`
  but no "tear-down" hook. Refresh is covered (see "Mounts are not
  sync peers" above and `workspace.refreshMount`), but a provider
  that grows a background task has no place to clean up. No caller
  needs this today; revisit when one does.
