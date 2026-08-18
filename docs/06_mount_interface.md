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
