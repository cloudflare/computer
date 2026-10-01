# 20. Local-only paths

> [!NOTE]
> Addresses [#179](https://github.com/cloudflare/computer/issues/179).
> Shipped behaviour as of `@cloudflare/computerd` with `MOUNT_IGNORE`
> support; the client-side assertion ships in `@cloudflare/computer`.

Everything a container command writes under `MOUNT_POINT` is recorded in
the VFS and pulled into the Durable Object after the command. That is
right for source. It is wrong for `node_modules`, `.venv`, `target/`,
`dist/` and caches: tens of thousands of rebuildable files that never
need to be durable, and whose transfer can take minutes.

`MOUNT_IGNORE` names paths that stay on the container's local disk
instead. They are never recorded in the VFS, never pushed, and never
pulled.

## The trade-off, stated plainly

This is the part to read before configuring anything.

Content under a local-only path:

- **is visible only inside the container.** Commands see it through the
  mount as usual. `workspace.fs`, the worker shell, and any host-side
  tool reading through the Workspace do not.
- **is not durable on its own.** It is absent from sync by design, so a
  container that is replaced without a snapshot restore loses it.
- **survives a container snapshot**, because `MOUNT_IGNORE_PATH` is a
  real filesystem path. That is the only durability it has, and the
  reason the default sits under `/tmp` rather than on a tmpfs.

That is the right trade for a dependency tree a package manager can
rebuild. It is the wrong trade for anything a user typed.

## Configuration

The set belongs to the **image**, not the client.

```dockerfile
ENV MOUNT_POINT=/workspace
ENV MOUNT_IGNORE_PATH=/tmp/workspace    # default: /tmp + $MOUNT_POINT
ENV MOUNT_IGNORE="node_modules
.venv
target
dist"
```

`MOUNT_IGNORE` is newline-delimited, because a path may legally contain
a comma or a space. Blank lines and `#` comments are skipped.

Entries are **plain paths relative to the mount root**. There is no glob
syntax and no negation: an entry names one location, and a path is
local-only if it equals that entry or sits beneath it.

| Entry | Means |
| --- | --- |
| `node_modules` | `$MOUNT_POINT/node_modules` and everything under it |
| `app/node_modules` | that one path, not `node_modules` elsewhere |
| `/dist` | the same as `dist`; a leading slash is accepted and stripped |

Note the second row. An entry does **not** match at every depth, so a
monorepo that clones packages into `app/`, `web/` and `api/` lists each
`<pkg>/node_modules` separately. That is more lines in a `Dockerfile`,
and in exchange the set of paths that lose durability is a list you can
read rather than a pattern language whose matches you have to work out.

### Why it is per-image

The mount is per-container and compiled once at startup, so two sessions
sharing an image cannot hold different views of which paths are durable.
A per-session option would promise a knob the architecture cannot
honour.

Clients may still *declare* what they expect, and
`CloudflareContainerBackend` will refuse to connect if the image
disagrees:

```ts
new CloudflareContainerBackend({
  container: env.CONTAINER,
  workspace: { binding: "SESSIONS", id: sessionId },
  ignore: ["node_modules", ".venv", "target", "dist"],
});
```

This is an assertion, not a setting. Omit it to accept whatever the
image provides. Supplying it is how a deployment notices an image
rebuilt with a changed or missing `MOUNT_IGNORE` — which otherwise
surfaces only as a large, slow, unexplained pull.

The resolved set is readable back off the handle:

```ts
const handle = await backend.connect();
handle.ignore; // { paths, root, supported }
```

`supported: false` means the container predates the feature, so every
path is synced regardless of configuration. Worth logging.

### Validation

`MOUNT_IGNORE_PATH` must be absolute, must not be the filesystem root,
and must not be equal to or inside `MOUNT_POINT` — a root inside the
mount would make the passthrough layer resolve into itself. Entries may
not contain `.` or `..` segments; an entry that walks out of the mount
is a configuration mistake, and silently clamping it would hide the
mistake behind a path that looks intentional.

All of these fail the daemon at startup rather than disabling the
feature quietly. A dropped entry means a full `node_modules` goes into
the Durable Object, which is the failure this exists to prevent.

Duplicates, and entries nested inside another entry, are dropped as
redundant and reported.

## Diagnostics

`/__computerd/info` reports the resolved configuration:

```jsonc
{
  "ignore": {
    "supported": true,
    "enabled": true,
    "root": "/tmp/workspace",
    "paths": ["node_modules", "dist"],
    "redundant": ["node_modules/.cache"],
    "fastPaths": {
      "passthrough": false,
      "passthroughReason": "fuse-native binds libfuse 2.9; FOPEN_PASSTHROUGH requires the libfuse 3.17 API",
      "writebackCache": false
    }
  }
}
```

`paths` is the **normalised** set — what the mount actually applies, not
what was typed. That is what makes the client-side assertion meaningful.

`fastPaths.passthrough` is `false` on current builds and this is
expected, not a fault. See [Performance](#performance).

## Renames across the boundary: `EXDEV`

The one runtime failure a correctly configured deployment can still hit,
and the one worth understanding before it happens.

A rename whose source and destination sit on opposite sides of the
boundary returns **`EXDEV`** (`cross-device link`).

```
$ mv .tmp-build dist
mv: cannot move '.tmp-build' to 'dist': Invalid cross-device link
```

### Why it is not just done anyway

The two sides are different filesystems. A rename between them cannot be
atomic, and `rename(2)` promises atomicity. computerd could copy the
bytes and unlink the source, and the operation would appear to succeed —
but a crash midway would leave a half-written file where the caller was
promised all-or-nothing. Faking atomicity is worse than refusing it,
because the failure it creates is silent and arrives later.

`EXDEV` is also not an exotic error. It is what any Unix returns for a
cross-device rename, so `mv`, Node's `fs.rename`, Python's
`shutil.move`, and Go's `os.Rename` callers already fall back to
copy-then-unlink. Most tools recover without noticing.

### The fix

Ignore the staging path alongside its destination.

This case is common because it is how build tools work: write into a
temporary sibling, then rename into place atomically. If the destination
is local-only and the staging directory is not, every build hits this.

```dockerfile
ENV MOUNT_IGNORE="dist
.tmp-build"
```

Candidates worth checking in your own image: `.next` (Next.js writes
through `.next/cache`), `.turbo`, `node_modules/.cache`, and any
`*.tmp` staging directory a bundler creates next to its output.

computerd logs the guidance on the first crossing rename per mount,
naming both sides and the entry to add:

```
computerd: rename /.tmp-build -> /dist crossed the local-only boundary and
returned EXDEV. /dist is container-local (MOUNT_IGNORE), /.tmp-build is
synced to the workspace; a rename between them cannot be atomic, so it is
refused rather than silently copied. Most callers fall back to
copy-then-unlink. To keep the rename atomic, add ".tmp-build" to
MOUNT_IGNORE as well. Further occurrences are not logged.
```

It logs once because a build that does this does it in a loop. The
per-mount count is available on the passthrough stats.

Renames **within** one layer are ordinary atomic renames, in both the
local-only layer and the VFS.

## Performance

The win is in what is skipped: an ignored write does not enter the VFS,
the SQLite store, the change-pack encoding, or the pull into the Durable
Object. For a dependency install, that is the difference between
transferring tens of thousands of files and transferring none.

What is **not** skipped is the FUSE round trip itself. The bytes still
cross from the kernel into the daemon before reaching local disk.

> [!NOTE]
> This is why `fastPaths.passthrough` reports `false`. The kernel
> supports `FOPEN_PASSTHROUGH` (6.9+), and Cloudflare Containers hosts
> are well above that line — but computerd mounts through
> `fuse-native`, which binds **libfuse 2.9**, and passthrough requires
> the libfuse 3.17 API. The same constraint rules out writeback caching,
> which libfuse 2.9 rejects at mount time.
>
> So expect a local-only path to perform like the existing mount
> (see [19. Performance](./19_performance.md), roughly 2x slower than
> raw disk for `npm install`), not like raw disk. The saving is the
> transfer, not the I/O. This flips on a binding upgrade rather than an
> infrastructure change, which is why the field is reported rather than
> omitted.

## Relationship to `sync.fetchChanges({ ignore })`

These are different mechanisms with a confusingly similar name.

| | `MOUNT_IGNORE` | `fetchChanges({ ignore })` |
| --- | --- | --- |
| Layer | FUSE mount | sync RPC |
| Effect | path never enters the VFS | path is skipped in this transfer |
| Scope | durability boundary | transfer filter |

If you built a wrapper that injects `ignore` into `fetchChanges` to keep
a dependency tree out of the Durable Object, `MOUNT_IGNORE` replaces it
— **delete the wrapper rather than keeping both**. Keeping both leaves
the path excluded from transfer while still occupying the container's
store, which is the half-fixed state `MOUNT_IGNORE` exists to resolve.

Note also that `ignore` appears on both `fetchChanges` and the optional
`fetchChangePack` overload. A wrapper covering only the first silently
bypasses the filter on exactly the large transfers it was written for.
