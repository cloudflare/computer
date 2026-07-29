# 13. Git interface

> [!NOTE]
> This doc describes shipped code in `packages/computer/src/git/`
> and the `git` custom command in
> `packages/computer/src/backends/worker/`. Everything below
> works today.

`workspace.git` is the third major surface on `Workspace`,
alongside `fs` and `shell`. It runs every operation against the
local SQLite-backed VFS through `isomorphic-git`, so a
filesystem-only workspace (no backend) can drive a full
clone/commit/diff cycle.

Two doors into the same implementation:

- A typed JavaScript API — `workspace.git.clone({ url })`,
  `workspace.git.commit({ message })`, and so on. The
  argument shapes are object-options with named fields; return
  values are structured.
- An argv-driven entry point — `workspace.git.cli({ argv,
  cwd, env, stdin })`. Every flag-shape decision lives in
  `git/cli.ts`; the typed methods route to the same dependency-
  injected cores so the two surfaces cannot drift.

The worker backend's shell isolate registers a `git` custom
command that forwards across the loopback to the host
durable object's `workspace.git.cli(...)`. Running `git ...`
inside `bash.exec` reaches the same dispatcher and the same
underlying methods.

## Scope

Supported subcommands today:

```
add         clone         init          merge         rm
branch      commit        log           pull          show
cat-file    config        ls-files      push          stash
checkout    diff          ls-tree       remote        status
clean       fetch         reset         rev-parse     switch
                                        symbolic-ref  tag
                                        update-ref
```

Global options accepted before the subcommand:

- **`-C <path>`** — run the subcommand as though invoked from
  `<path>`. A relative path joins onto the caller's cwd. A
  single occurrence is supported; a second `-C` is rejected.

Deliberate omissions, with rationale:

- **SSH transport.** `isomorphic-git` has none. `https://`,
  `http://`, and `file://` are the only supported URL schemes;
  every command that takes a URL validates the scheme up
  front and refuses anything else.
- **Partial clone (`--filter=blob:none`).** `isomorphic-git`
  doesn't speak the v2 `filter` capability. `paths` on
  `clone` provides partial *checkout* (the working tree is
  restricted), which is the agent-relevant subset; every blob
  reachable from the tip tree is still fetched.
- **`git gc`, `repack`, `prune`, hooks, worktrees, submodules.**
  No `isomorphic-git` surface for any of them.
- **`reset --soft` / `--mixed`, `cherry-pick`, `revert`,
  `blame`.** Out of scope until a concrete caller needs them;
  each can land as its own follow-up. `reset` covers path
  unstaging and `--hard`; the other modes exit 129.

## Known gaps

The items below are intended to work but currently don't, or
work in a way that differs from real git in a surprising way.
Each is something to fix rather than a deliberate omission.

- **The working tree is shared across branches; `checkout`
  updates HEAD and the index but does not reconcile
  untracked files.** A file created on `feature` and never
  committed remains on disk after switching to `main`, and
  `status` reports it as untracked on every branch. Real git
  carries the same behavior for untracked files, but it also
  removes tracked-on-one-branch / absent-on-the-other files
  from disk on checkout; the workspace CLI does not. Reach
  for `rm` before `checkout` if a clean working tree matters.

- **Several real-git flags are rejected as unknown.**
  `branch -a`, `show --stat`, `hash-object <path>` (the
  file-path form, only `--stdin` is supported), and a wider
  set of long-option flags listed in each command's *Not
  mapped* block above. The CLI exits 129 with an `unknown
  option '...'` line on stderr.

- **Symlinks in a cloned tree are checked out as symlinks
  but the target may not resolve.** `clone` materializes
  mode-`120000` entries as symbolic links in the workspace
  VFS, but a downstream `read` / `cat` of one through the
  shell can produce `No such file or directory` if the target
  is a path outside what the clone wrote. Top-level
  redirects (`README.md -> packages/foo/README.md`) on
  symlinked-readme repositories are the most common case.
  Workaround: read the symlink target with `readlink` or
  walk the link manually through `fs.readlink`.

File a bug if you hit one of these and need a fix prioritized.

## Quick start

Three flavors of the same task — clone a repo, mutate a file,
diff against HEAD — through each entry point.

### Typed API from a durable object

```ts
import { Workspace } from "@cloudflare/computer";

const ws = new Workspace({ storage: ctx.storage });
await ws.git.clone({ url: "https://github.com/example/repo.git" });
await ws.fs.writeFile("/README.md", "hello world\n");
const patch = await ws.git.diff();
console.log(patch);
```

### Argv from a durable object

```ts
await ws.git.cli({ argv: ["clone", "https://github.com/example/repo.git"] });
await ws.fs.writeFile("/README.md", "hello world\n");
const { stdout } = await ws.git.cli({ argv: ["diff"] });
console.log(stdout);
```

### Inside the shell (worker backend)

```ts
const handle = await ws.shell.exec(
  "git clone https://github.com/example/repo.git . && " +
    "echo 'hello world' > README.md && " +
    "git diff",
);
const { stdout } = await handle.result();
```

The shell-side `git` is the same dispatcher behind a custom
command; the just-bash shell never resolves a binary on PATH.
The sibling [`artifacts` command](./15_artifacts_interface.md)
follows the same pattern through `workspace.artifacts.cli(...)` when the Workspace is configured with an Artifacts binding.

## Cross-cutting

### `dir`

Every operation takes an optional `dir` working-tree path. It
defaults to `/`. The argv side falls back to `cwd` from the
shell command's environment when no positional dir is given.
Identity defaulting and config reads only honor the local
`<dir>/.git/config` — there is no global `~/.gitconfig`
fallback. Layer one on top of the typed surface if you need
it.

### Identity

Commit-producing subcommands (`commit`, `pull` and `merge`
when they materialize a merge commit) resolve the author /
committer in this order:

1. Explicit `options.author` / `options.committer` on the
   typed call. `--author "Name <email>"` on `git commit` from
   the CLI.
2. `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` and
   `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` from the
   `env` passed to the call (or to `cli({ env })`). The
   shell-side custom command flattens the just-bash env Map
   into this shape automatically.
3. Local repo config `user.name` / `user.email`, as written
   by `git config user.email "..."`. Only the local
   `<dir>/.git/config` is consulted; there is no global
   `~/.gitconfig` fallback.
4. `defaultIdentity` from `createGitClient` / `new Workspace({
   defaultGitIdentity })`.

If none of the four yields a name and email,
`MissingIdentityError` fires. The CLI surfaces it as `git
commit: author identity unknown` with exit code 128. This
config-after-env order matches real git.

### Auth (`headers` and `onAuth`)

Network commands (`fetch`, `pull`, `push`, `clone`) accept the
same auth contract `isomorphic-git` exposes:

- `headers` — applied verbatim to every HTTP request. Use this
  for static authentication, e.g. a GitHub PAT:
  ```ts
  await ws.git.clone({
    url: "https://github.com/private/repo.git",
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}` },
  });
  ```
- `onAuth(url, auth)` — called when the remote sends a 401.
  Return a `GitAuth` (`username` / `password` / `headers`) and
  `isomorphic-git` retries with it.

The CLI does not surface `onAuth` (no clean argv shape for a
callback); for interactive flows reach for the typed API.

### Errors

The typed surface throws subclasses of `GitError`:

| Class | Code | CLI exit |
|---|---|---|
| `NotARepositoryError` | `ENOTAREPO` | 128 |
| `AlreadyInitializedError` | `EALREADYINIT` | 128 |
| `MissingIdentityError` | `EIDENTITY` | 128 |
| `PathOutsideRepoError` | `EPATHOUTSIDE` | 128 |
| `PathspecNotFoundError` | `EPATHSPEC` | 128 |
| any other `GitError` | per-call (`EFETCHFAIL`, etc.) | 1 |

Exit code 129 on the CLI is reserved for argv-shape errors
(unknown options, missing required values, malformed inputs).
The dispatcher prints `git <subcommand>: <message>\n` on
stderr for every failure, matching the shape real git uses for
unknown commands and parse errors so callers can match on it.

### Progress and buffered output

Network commands accept `onProgress` and `onMessage` callbacks
on the typed surface. Both fire from inside `isomorphic-git`
during the operation.

The CLI surface buffers progress on the host side and flushes
it on stderr at the end. A long `git clone` from inside the
shell produces no output until the call returns; streaming
progress would need a second exec-event channel. The shell
isolate has `globalOutbound: null`, so network requests
themselves happen on the host durable object, not in the
isolate — they work despite the restriction.

### `cache`

Each `GitClient` owns one shared pack/index cache passed to
every `isomorphic-git` call against this workspace. Without
this every `readBlob` / `statusMatrix` / `walk` re-parses the
packfile, which is the difference between a sub-second `diff`
and one that hangs for minutes on a real repository.

The cache is not bounded. A workspace that clones a 1 GB
repository will hold the parsed pack in DO memory. Workable
for the agent-scale workspaces this package targets, but worth
calling out — bounded or per-call-opt-out caching is a
follow-up if it becomes a problem in practice.

## Command reference

Each entry lists the canonical CLI invocation, the TS
signature, the flag-to-option mapping, and any flags from real
git that aren't covered.

### `init`

```
git init [--initial-branch=<name>] [--bare] [<dir>]
```

```ts
ws.git.init({
  dir?: string,
  defaultBranch?: string,   // default "main"
  bare?: boolean,           // default false
}): Promise<void>
```

| Flag | TS field |
|---|---|
| `--initial-branch <name>` / `-b <name>` | `defaultBranch` |
| `--bare` | `bare` |
| `<dir>` (positional) | `dir` |

*Not mapped:* `--separate-git-dir`, `--shared`, `--template`,
`--object-format`. None are wired into `isomorphic-git`'s
`init`.

### `status`

```
git status [--porcelain[=v2]] [--short | -s]
```

```ts
ws.git.status({
  dir?: string,
}): Promise<StatusEntry[]>

interface StatusEntry {
  path: string;
  index:    " " | "A" | "M" | "D";
  worktree: " " | "A" | "M" | "D" | "?";
}
```

The CLI default is porcelain v2. `--porcelain=v1` (and the
`1` spelling git also accepts) produces the v1 `XY <path>`
form with `??` for untracked files; `--short` / `-s` produces
the short form (` ?` for untracked). The typed surface returns
the underlying `StatusEntry[]`; format it with
`formatPorcelainV2`, `formatPorcelainV1`, or `formatShort`
from `@cloudflare/computer/git`.

*Not mapped:* `--branch`, `--ignored`, `--untracked-files`,
the long human-readable form. The structured return is the
primary surface.

### `add`

```
git add [-A|--all] [-f|--force] <pathspec>...
```

```ts
ws.git.add({
  dir?: string,
  paths: string[],
  all?: boolean,
  trackedOnly?: boolean,
  force?: boolean,
}): Promise<void>
```

| Flag | TS field |
|---|---|
| `-A` / `--all` | `all` |
| `--force` / `-f` | `force` |
| `<pathspec>...` (positional) | `paths` |

`-A` stages every change under the repo — new, modified, and
deleted tracked files — and ignores any pathspec. `trackedOnly`
(no CLI flag of its own; set by `commit -a`) restricts `all`
mode to paths already in HEAD, so untracked files are left
alone. *Not mapped:* `--update`, `--intent-to-add`, `-p`
interactive.

### `rm`

```
git rm <pathspec>...
```

```ts
ws.git.rm({
  dir?: string,
  paths: string[],
}): Promise<void>
```

`isomorphic-git`'s `remove` only unstages — it does not touch
the working tree. `--cached` is the only mode supported.
*Not mapped:* `-r`, `-f`, `--ignore-unmatch`.

### `commit`

```
git commit [-a] -m <msg> [--amend] [--author="Name <email>"]
```

```ts
ws.git.commit({
  dir?: string,
  message: string,
  author?: { name: string; email: string },
  committer?: { name: string; email: string },
  amend?: boolean,
  env?: Record<string, string>,
}): Promise<{ oid: string }>
```

| Flag | TS field |
|---|---|
| `-m <msg>` / `--message <msg>` | `message` |
| `-a` | (stages tracked changes first) |
| `--amend` | `amend` |
| `--author "Name <email>"` | `author` |

Identity precedence: `options.author` → env → local config
(`user.name` / `user.email`) → `defaultIdentity`. `-a` (and the
`-am` cluster) stages tracked modifications and deletions —
never untracked files — before committing; a staging failure
aborts before the commit runs. The CLI prints `[<short-oid>]
<subject>` on success, matching the first line of real git's
commit summary.

*Not mapped:* `--no-edit`, `--signoff`, `--gpg-sign`,
`-F <file>`.

### `log`

```
git log [-n <N>] [-<N>] [--oneline] [<ref>]
```

```ts
ws.git.log({
  dir?: string,
  ref?: string,           // default "HEAD"
  depth?: number,
}): Promise<CommitView[]>
```

| Flag | TS field |
|---|---|
| `-n <N>` | `depth` |
| `-<N>` (e.g. `-1`, `-5`) | `depth` |
| `--oneline` | (CLI formatter) |
| `<ref>` (positional) | `ref` |

The positional `<ref>` accepts revision suffixes (`HEAD~2`,
`<branch>^`); they resolve through `rev-parse` before the walk.

The CLI default emits `commit / Author / Date / message`
blocks; `--oneline` collapses each entry to `<short-oid>
<subject>`. The typed surface returns `CommitView[]` (oid,
message, tree, parent, author, committer) so callers can
format their own way.

*Not mapped:* `--graph`, `--all`, `--since`, `--until`,
`-p`, `--stat`, `--follow`, `--reverse`.

### `show`

```
git show [<ref>]
```

```ts
ws.git.show({
  dir?: string,
  ref: string,
}): Promise<CommitView>
```

CLI defaults `ref` to `HEAD`. Output matches the full `log`
form for one commit. *Not mapped:* the diff-attached form
real git's `show` produces — use `git log` plus `git diff
<parent> <ref>` for that.

### `rev-parse`

```
git rev-parse [--abbrev-ref] [--show-toplevel] <ref>
```

```ts
ws.git.revParse({
  dir?: string,
  ref: string,
}): Promise<string>

ws.git.repoRoot({ dir?: string }): Promise<string>
```

Resolves a ref (branch, tag, short oid prefix) to its full
SHA-1. Revision suffixes from `gitrevisions(7)` are supported:
`HEAD^`, `HEAD~N`, `<ref>^N`, and chained forms like `HEAD~2^2`.
`^`/`~N` follow first parents; `^N` selects parent N. Walking
past the root commit is an error.

| Flag | Behavior |
|---|---|
| `--abbrev-ref HEAD` | Print the current branch; fall back to the oid on detached HEAD. |
| `--show-toplevel` | Print the working-tree root (`repoRoot`); walks up to find `.git`. Exits 128 outside a repo. |

*Not mapped:* `--git-dir`, `--is-inside-work-tree`, and the
rest of `rev-parse`'s wide flag surface.

### `symbolic-ref`

```
git symbolic-ref [--short] [-q|--quiet] [HEAD]
```

```ts
ws.git.currentBranch({
  dir?: string,
  fullname?: boolean,     // default true
}): Promise<string | undefined>
```

Only `HEAD` is supported. `--short` returns `<name>`,
otherwise `refs/heads/<name>`. Returns / prints nothing on
detached HEAD; the CLI exits 1.

### `ls-files`

```
git ls-files [--ref <ref>]
```

```ts
ws.git.lsFiles({
  dir?: string,
  ref?: string,
}): Promise<string[]>
```

Without `--ref`, lists files in the index. With `--ref`,
lists files in that tree. *Not mapped:* `-s`, `--stage`,
`--others`, `--exclude-standard`.

### `ls-tree`

```
git ls-tree <tree-ish> [<path>]
```

```ts
ws.git.lsTree({
  dir?: string,
  ref: string,
  path?: string,
}): Promise<TreeEntryView[]>

interface TreeEntryView {
  mode: string;             // "100644", "040000", "160000"
  path: string;
  oid: string;
  type: "blob" | "tree" | "commit";
}
```

CLI output matches real git's
`<mode> <type> <oid>\t<path>`. *Not mapped:* `-r` recursive,
`-l` long form, `--name-only`.

### `clone`

```
git clone [--depth N] [--branch B] [--single-branch] [--no-tags]
          <url> [<dir>]
```

```ts
ws.git.clone({
  url: string,
  dir?: string,
  ref?: string,
  paths?: string[],         // partial checkout only
  depth?: number,           // default 1
  singleBranch?: boolean,
  noTags?: boolean,
  headers?: Record<string, string>,
  corsProxy?: string,
  onProgress?: ProgressCallback,
  onMessage?: MessageCallback,
}): Promise<void>
```

| Flag | TS field |
|---|---|
| `--depth <N>` | `depth` |
| `--branch <B>` / `-b <B>` | `ref` |
| `--single-branch` / `--no-single-branch` | `singleBranch` |
| `--no-tags` / `--tags` | `noTags` |
| `<url>` (positional) | `url` |
| `<dir>` (positional) | `dir` |

When `<dir>` is omitted, the CLI derives it from the last path
segment of the URL, stripping a trailing `.git` — `git clone
https://github.com/owner/repo.git` lands in `./repo`, matching
real git. A URL whose basename can't produce a safe directory
name exits 129; pass an explicit destination. After clone, HEAD
is a symbolic ref to the checked-out branch, so `branch
--show-current` and `symbolic-ref HEAD` work immediately.

Only `https://`, `http://`, and `file://` schemes are
accepted. *Not mapped:* `--bare`, `--mirror`, `--recurse-
submodules`, `--filter`, ssh URLs.

### `diff`

```
git diff [--stat|--name-only|--name-status] [<from> [<to>]] [-- <path>...]
```

```ts
ws.git.diff({
  dir?: string,
  ref?: string,
  to?: string,
  paths?: string[],
}): Promise<string>

ws.git.diffSummary({
  dir?: string,
  ref?: string,
  to?: string,
  paths?: string[],
}): Promise<DiffSummaryEntry[]>

interface DiffSummaryEntry {
  path: string;
  status: "A" | "M" | "D";
  insertions: number;
  deletions: number;
}
```

Three modes:

- `git diff` — working tree vs HEAD.
- `git diff <ref>` — working tree vs `<ref>`.
- `git diff <from> <to>` — `<from>` vs `<to>` (commit pair).

Paths after `--` filter the output. Matching is exact-or-
directory-prefix; globs are not supported. The `<from>` / `<to>`
refs accept revision suffixes (`HEAD~1`).

The summary flags share the same change set as the patch:

| Flag | Output |
|---|---|
| `--stat` | Per-file `path \| total +++---` bar plus a `N files changed, …` footer. |
| `--name-only` | One changed path per line. |
| `--name-status` | `<status>\t<path>` per line. |

*Not mapped:* `--cached`, `-U <N>`, the three-dot form.

### `branch`

```
git branch                           # list
git branch --show-current            # print the current branch
git branch <name> [<start-point>]    # create
git branch -d <name>                 # delete
git branch --force <name> <start>    # overwrite
```

```ts
ws.git.branch({
  dir?: string,
  name: string,
  startPoint?: string,
  force?: boolean,
}): Promise<void>

ws.git.branchDelete({ dir?: string, name: string }): Promise<void>
ws.git.branchList({ dir?: string }): Promise<string[]>
ws.git.currentBranch({ dir?: string }): Promise<string | undefined>
```

Bare `git branch` lists local branches with the current one
prefixed `* `. The CLI mode is selected by positional shape:
zero positionals lists, one creates at HEAD, two creates at
a start point, `-d` switches to delete (and consumes one or
more positionals). `--show-current` prints the checked-out
branch (nothing on detached HEAD).

### `tag`

```
git tag                              # list
git tag <name> [<object>]            # create
git tag -d <name>                    # delete
```

```ts
ws.git.tag({
  dir?: string,
  name: string,
  object?: string,
  force?: boolean,
}): Promise<void>

ws.git.tagDelete({ dir?: string, name: string }): Promise<void>
ws.git.tagList({ dir?: string }): Promise<string[]>
```

Only lightweight tags are supported. *Not mapped:* `-a`
annotated tags, `-s` signed tags, `-n <N>` annotation
preview.

### `checkout`

```
git checkout [--force] <ref> [-- <paths>...]
git checkout -b <new-branch> [<start-point>]
```

```ts
ws.git.checkout({
  dir?: string,
  ref: string,
  paths?: string[],
  force?: boolean,
}): Promise<void>
```

With `paths` set, the working tree updates to match `ref`
for those paths only; HEAD does not move (matching `git
checkout <ref> -- <path>`). Without `paths`, HEAD moves to
`ref`. `-b` creates a branch (optionally at a start point)
and switches to it; the branch is created first, so a name
collision leaves the working tree untouched.

*Not mapped:* `--detach`, `--orphan`, `--theirs`, `--ours`.

### `switch`

```
git switch <branch>
git switch -c <new-branch> [<start-point>]
```

The modern spelling of `checkout` for branch movement. `git
switch <branch>` moves HEAD; `-c` is the `checkout -b`
equivalent. Both delegate to `checkout` / `branch` on the
typed surface. *Not mapped:* `--detach`, `-C` force-create,
`--orphan`.

### `fetch`

```
git fetch [--depth N] [--prune] [--tags|--no-tags] [<remote>|<url>] [<ref>]
```

```ts
ws.git.fetch({
  dir?: string,
  remote?: string,
  url?: string,
  ref?: string,
  remoteRef?: string,
  depth?: number,
  singleBranch?: boolean,
  tags?: boolean,
  prune?: boolean,
  headers?: Record<string, string>,
  onAuth?: AuthCallback,
}): Promise<{ defaultBranch: string | null; fetchHead: string | null }>
```

The CLI routes a positional that starts with a URL scheme to
`url`; anything else is a remote name. *Not mapped:*
`--unshallow`, `--all`, `--shallow-since`, `--prune-tags`.

### `push`

```
git push [--force|-f] [--delete|-d] [<remote>|<url>] [<ref>]
```

```ts
ws.git.push({
  dir?: string,
  remote?: string,
  url?: string,
  ref?: string,
  remoteRef?: string,
  force?: boolean,
  delete?: boolean,
  headers?: Record<string, string>,
  onAuth?: AuthCallback,
}): Promise<PushResult>

interface PushResult {
  ok: boolean;
  error: string | null;
  refs: Record<string, { ok: boolean; error?: string }>;
}
```

A non-ok `PushResult` surfaces as exit 1 on the CLI with the
error string on stderr. *Not mapped:* `--tags`, `--set-
upstream`, `--atomic`, `--mirror`.

### `pull`

```
git pull [--ff-only] [--no-ff] [<remote>|<url>] [<ref>]
```

```ts
ws.git.pull({
  dir?: string,
  remote?: string,
  url?: string,
  ref?: string,
  fastForward?: boolean,
  fastForwardOnly?: boolean,
  headers?: Record<string, string>,
  onAuth?: AuthCallback,
  author?: { name: string; email: string },
  committer?: { name: string; email: string },
  env?: Record<string, string>,
}): Promise<void>
```

Identity follows the same precedence as `commit`; if a merge
commit is needed and no identity resolves,
`MissingIdentityError` fires.

### `merge`

```
git merge [--ff-only] [--no-ff] [-m <msg>] <ref>
```

```ts
ws.git.merge({
  dir?: string,
  theirs: string,
  ours?: string,
  fastForward?: boolean,
  fastForwardOnly?: boolean,
  message?: string,
  author?: { name: string; email: string },
  committer?: { name: string; email: string },
  env?: Record<string, string>,
}): Promise<{ oid?: string; alreadyMerged?: boolean; fastForward?: boolean }>
```

The CLI prints a one-line summary: `Already up to date.`,
`Fast-forward to <short-oid>`, or `Merge commit <short-oid>`.

### `remote`

```
git remote                       # list names
git remote -v                    # list with URLs
git remote add [-f] <name> <url>
git remote remove <name>         # or `rm`
```

```ts
ws.git.remoteAdd({
  dir?: string,
  name: string,
  url: string,
  force?: boolean,
}): Promise<void>

ws.git.remoteRemove({ dir?: string, name: string }): Promise<void>
ws.git.remoteList({ dir?: string }): Promise<RemoteView[]>

interface RemoteView { name: string; url: string }
```

*Not mapped:* `remote rename`, `remote set-url`, `remote
show`, `remote prune`, `remote update`.

### `hash-object`

```
git hash-object [-w] --stdin
```

```ts
ws.git.hashObject({
  dir?: string,
  content: Uint8Array | string,
  write?: boolean,
}): Promise<string>
```

The CLI surface only covers the `--stdin` form. The file-path
form would pull in workspace path resolution and a buffered
readback that the typed API serves better directly.

### `cat-file`

```
git cat-file -p <oid>[:<path>]
```

```ts
ws.git.catFile({
  dir?: string,
  oid: string,
  filepath?: string,
}): Promise<{ oid: string; bytes: Uint8Array }>
```

Supports the `<oid>:<path>` shorthand for tree subreads.
*Not mapped:* `-t` type, `-s` size, `--batch`.

### `update-ref`

```
git update-ref [--force] <ref> <value>
```

```ts
ws.git.updateRef({
  dir?: string,
  ref: string,
  value: string,
  force?: boolean,
  symbolic?: boolean,
}): Promise<void>
```

*Not mapped:* `-d` delete, `--stdin` batch.

### `config`

```
git config <key>                    # get
git config --get-all <key>          # get all values
git config <key> <value>            # set
git config --add <key> <value>      # append multi-valued
git config --unset <key>            # unset
```

```ts
ws.git.configGet({
  dir?: string,
  path: string,
  all?: boolean,
}): Promise<string | string[] | undefined>

ws.git.configSet({
  dir?: string,
  path: string,
  value: string | boolean | number | undefined,
  append?: boolean,
}): Promise<void>
```

A missing key returns `undefined` from `configGet` and exits
1 with empty stdout from the CLI, matching `git config
--get`'s behavior. Only the local `<dir>/.git/config` file is
read or written; global and system configs are not consulted.

### `reset`

```
git reset [-- <paths>...]            # unstage paths (against HEAD)
git reset --hard [<ref>]             # restore tracked files to <ref>
```

```ts
ws.git.reset({
  dir?: string,
  paths?: string[],
  hard?: boolean,
  ref?: string,            // default "HEAD"
}): Promise<void>
```

Path reset unstages the listed paths back to `ref` and leaves
the working tree alone (built on `resetIndex`). Bare `git reset`
and `git reset HEAD` unstage all staged paths. `--hard` moves the
current branch (when HEAD is symbolic) to `ref` and rewrites both
the index and working tree. With `--hard`, a single positional is
the ref. Refs accept revision suffixes (`HEAD~1`). *Not mapped:*
`--soft`, `--mixed` (both exit 129), `--merge`, `--keep`.

### `stash`

```
git stash [push [-m <msg>]]          # stash tracked changes (bare = push)
git stash list                       # list entries
git stash pop                        # restore the latest entry
```

```ts
ws.git.stashPush({ dir?: string, message?: string }): Promise<void>
ws.git.stashList({ dir?: string }): Promise<string[]>
ws.git.stashPop({ dir?: string, index?: number }): Promise<void>
```

`push` stashes tracked working-tree changes and restores a
clean tree; it creates a commit internally, so it needs a
resolvable identity (see [Identity](#identity)). `list`
returns `stash@{N}: <message>` entries newest-first. `pop`
restores the latest entry. *Not mapped:* `apply`, `drop`,
`clear`, `--include-untracked`, `stash@{N}` selectors on pop.

### `clean`

```
git clean -f [-d] [-n|--dry-run]
```

```ts
ws.git.clean({
  dir?: string,
  directories?: boolean,
  dryRun?: boolean,
}): Promise<string[]>   // repo-relative paths removed
```

Removes untracked files under the repo and returns the paths
removed. Like real git, it refuses to act without `-f` unless
previewing with `-n` / `--dry-run`, and only descends into
untracked directories with `-d`. The untracked set is derived
from a status-matrix walk; ignored-file handling is not
modeled, so every untracked path is a candidate. *Not mapped:*
`-x` / `-X` ignore handling, pathspec limiting.

## Flag-to-option mapping (alphabetical)

| Flag | Subcommand | TS option |
|---|---|---|
| `-C <path>` | (global) | rewrites effective cwd |
| `-A` / `--all` | `add` | `all` |
| `--abbrev-ref` | `rev-parse` | (via `currentBranch`) |
| `-a` | `commit` | (stages tracked changes) |
| `--amend` | `commit` | `amend` |
| `--author` | `commit` | `author` |
| `-b <new>` | `checkout` | (create + switch) |
| `-b <B>` (branch) | `clone`, `init` | `ref` / `defaultBranch` |
| `--bare` | `init` | `bare` |
| `--branch <B>` | `clone` | `ref` |
| `-c <new>` | `switch` | (create + switch) |
| `--cached` | `rm` | (implicit) |
| `-d` | `clean` | `directories` |
| `-d` / `--delete` | `branch`, `tag`, `push` | `branchDelete` / `tagDelete` / `delete` |
| `--depth <N>` | `clone`, `fetch` | `depth` |
| `--dry-run` / `-n` | `clean` | `dryRun` |
| `--ff-only` | `pull`, `merge` | `fastForwardOnly` |
| `-f` / `--force` | `add`, `branch`, `checkout`, `clean`, `push`, `update-ref`, `remote add` | `force` |
| `--get-all` | `config` | `all` |
| `--hard` | `reset` | `hard` |
| `--initial-branch` | `init` | `defaultBranch` |
| `-m <msg>` | `commit`, `merge`, `stash push` | `message` |
| `-n <N>` | `log` | `depth` |
| `-<N>` (e.g. `-1`) | `log` | `depth` |
| `--name-only` | `diff` | (via `diffSummary`) |
| `--name-status` | `diff` | (via `diffSummary`) |
| `--no-ff` | `pull`, `merge` | `fastForward: false` |
| `--no-single-branch` | `clone` | `singleBranch: false` |
| `--no-tags` | `clone`, `fetch` | `noTags` / `tags: false` |
| `--oneline` | `log` | (formatter) |
| `--porcelain[=v1\|v2]` | `status` | (formatter) |
| `-p` | `cat-file` | (implicit) |
| `--prune` | `fetch` | `prune` |
| `-q` / `--quiet` | `symbolic-ref` | (formatter) |
| `--ref <r>` | `ls-files` | `ref` |
| `--short` | `symbolic-ref`, `status` | `fullname: false` / (formatter) |
| `--show-current` | `branch` | (via `currentBranch`) |
| `--show-toplevel` | `rev-parse` | (via `repoRoot`) |
| `-s` | `status` | (formatter) |
| `--single-branch` | `clone` | `singleBranch` |
| `--stat` | `diff` | (via `diffSummary`) |
| `--stdin` | `hash-object` | (implicit) |
| `--tags` | `clone`, `fetch` | `noTags: false` / `tags: true` |
| `--unset` | `config` | `value: undefined` |
| `-v` / `--verbose` | `remote` | (formatter) |
| `-w` | `hash-object` | `write` |

## Shell access

The worker backend's shell isolate registers a `git` custom
command on every `Bash` construction (see
[`docs/12_worker_backend.md`](./12_worker_backend.md)). The
command forwards across the loopback to the host durable
object's `workspace.git.cli(...)`. There is no `git` binary
on PATH; the just-bash interpreter only knows about its
built-in commands and the ones registered through
`customCommands`.

`ShellWorker` exposes a protected `extraCommands(ws)` hook for
subclasses that want to layer their own custom commands on top
of `git`. The base class returns an empty list; an override
prepends or appends to the array passed to `Bash`. Subclass
commands receive the live host stub the shell already reached,
so they share its lifetime without refetching.

```ts
import { ShellWorker, defineGitCommand } from "@cloudflare/computer/backends/worker";
import { type CustomCommand } from "just-bash";

class MyShell extends ShellWorker {
  protected override extraCommands(ws: HostWorkspaceStub): CustomCommand[] {
    return [defineMyCommand(ws)];
  }
}
```

Two properties of the shell-side path worth pinning:

- **Network commands work despite `globalOutbound: null`.**
  The Dynamic Worker hosting the shell has its globalOutbound
  set to `null`, blocking all outbound HTTP. `git clone`,
  `git fetch`, `git pull`, and `git push` still work because
  the actual HTTP request happens on the host durable object
  side, not in the shell isolate. The shell just hands the
  argv across the loopback and waits for the result.
- **Progress is buffered.** A long `clone` produces no output
  until the call returns. Progress callbacks fire on the host
  side; their output is collected into stderr and flushed at
  the end. Streaming progress through the shell would need a
  second exec-event channel.
