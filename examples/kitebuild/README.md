# kitebuild example

> [!IMPORTANT]
> This example uses an experimental part of Cloudflare Computer: the Kitebuild backend.
> Its API may change in any release, and it is not yet suitable for
> production use. See the [status table](../../packages/computer/README.md#status).

A Cloudflare Worker + Durable Object whose Workspace runs shell commands
on a Kitebuild machine: a BusyBox Linux userland that runs inside the
Durable Object that owns the Workspace. The HTTP surface is the same as
[`examples/worker-shell`](../worker-shell), so the same `curl` recipes
work.

Unlike the Worker shell, commands are real processes, so pipes,
background jobs and `wait` behave as on Linux, and output streams while
a command runs. Unlike the container backends, there is no container and
no second copy of the files: the machine mounts the Workspace's files at
`/workspace` and reads and writes them directly. See
[`docs/21_kitebuild_backend.md`](../../docs/21_kitebuild_backend.md) for
the backend itself.

## Architecture

```
client ─► Worker /c/<name>/{file,exec}
             │  (Durable Object RPC calls)
             ▼
       KitebuildExample ──► Workspace ──► KitebuildBackend
       (Durable Object)        │               │
                               │               ▼
                               │   ┌─ Kitebuild machine ─────────────┐
                               │   │ processes:                      │
                               │   │   sh, sort, awk  (busybox.wasm) │
                               │   │   git, assets    (JavaScript)   │
                               │   │        │ Linux syscalls         │
                               │   │        ▼                        │
                               │   │ kernel (TypeScript): processes, │
                               │   │ pipes, descriptors, VFS         │
                               │   │        │                        │
                               │   │        │ /workspace mount       │
                               │   └────────┼────────────────────────┘
                               ▼            ▼
                          Durable Object SQLite storage
                          (one copy of every file)
```

1. The Durable Object builds its Workspace through `withWorkspace`,
   passing a `KitebuildBackend` from
   `@cloudflare/computer/backends/kitebuild`. When the Workspace
   starts the backend, the backend creates a Kitebuild `Machine` from
   `@cloudflare/kitebuild-runtime` in the same Durable Object. There is
   no kernel or virtual machine underneath: BusyBox is compiled to
   wasm against a patched musl, and its Linux system calls land in a
   kernel written in TypeScript. That kernel keeps the process table,
   pipes, file descriptors and an in-memory filesystem tree, with
   `/bin` and `/etc` unpacked from the initramfs and `/tmp` in memory.
2. Programs come in two kinds, both sharing that kernel and its
   files. Any command the machine doesn't know otherwise runs as a
   BusyBox applet. `git`, `assets` and `artifacts` are written in JavaScript and run
   in the Durable Object itself; `git` is isomorphic-git working on
   the machine's own files.
3. The backend mounts the Workspace's `/workspace` directory at the
   same path inside the machine. The mount reads and writes the
   Workspace's own SQLite rows, so the file routes and the shell
   work on the same files. Directories load the first time a command
   looks at them, and file bytes are read through a cache of 8 MiB by
   default.
4. Each `exec` first applies any files written outside the machine
   since the last command, such as uploads through the file routes.
   It then starts `sh -c <command>`. Each program in a pipeline or
   background job becomes its own process with its own wasm instance
   and memory once it is started with `execve`. A system call that has to wait, such as reading an empty
   pipe, suspends that process through JavaScript Promise
   Integration (JSPI) and lets the others run. Output events are sent
   as the command writes them, and are also saved to SQLite so a run
   can be reattached with `getExec`.
5. When the command exits, the files it wrote are committed to the
   Workspace, and then the exit event is sent. A file written by a
   command is readable through `GET /c/<name>/file/...` as soon as
   the command's response ends.
6. `BackendHandle.sync` is `"none"`. With one store there is nothing
   to push or pull, and the runtime result's `pushed` and `pulled`
   counts are always zero.

There is no container, Dockerfile or Dynamic Worker. Everything runs
in the Durable Object, which also means the machine shares its
memory: each process holds its own wasm memory, so at most four
commands run at once by default.

## What the shell has

- BusyBox: `sh`, `sort`, `sed`, `awk`, `tar`, `gzip`, `find` and the rest.
- `git`, Kitebuild's own (`@cloudflare/kitebuild-toolchain/git`). It commits as
  the Workspace's `defaultGitIdentity` when a command sets no identity.
- No network. The backend's default egress is `none`, so `git clone`
  and `wget` are refused. See the backend docs to allow hosts through a
  gateway.

## Bundled skill

`src/skills/exec/SKILL.md` explains how `exec` works on this backend, for
an agent working in the workspace. It ships inside the Worker upload
through the `find_additional_modules` rule in `wrangler.jsonc`, and
`WorkerBundle("skills")` copies it to `/workspace/.agents/skills` as a
read-only mount, as in the Worker shell example. Mounting it also
creates `/workspace` when the Workspace starts, so a file can be
uploaded before any command has run.

```sh
curl -X POST -H 'content-type: application/json' \
  -d '{"command":"cat .agents/skills/exec/SKILL.md"}' \
  http://127.0.0.1:8787/c/demo/exec
```

## Packages

`@cloudflare/kitebuild-runtime` and `@cloudflare/kitebuild-toolchain` are not
on public npm yet. Until they are,
`npm install` fetches them from Cloudflare's internal npm registry; see
[`COLLABORATORS.md`](../../COLLABORATORS.md#setup) for the token it
needs.

## Run it locally

```sh
npm install
npm run dev --workspace @example/computer-kitebuild
```

Then:

```sh
curl http://127.0.0.1:8787/

printf 'b\na\nTODO: one\nb\n' | curl -X PUT --data-binary @- \
  http://127.0.0.1:8787/c/demo/file/workspace/notes.txt

curl -X POST http://127.0.0.1:8787/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"command":"sort notes.txt | uniq -c | sort -rn; uname -m"}'

curl -X POST http://127.0.0.1:8787/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"command":"grep -rn TODO . | wc -l"}'

curl -X POST http://127.0.0.1:8787/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"command":"git init -q repo && cd repo && cp ../notes.txt . && git add notes.txt && git commit -q -m notes && git log --oneline"}'
```

Pass `"stream": true` to get output as it is written, followed by the
exit code:

```sh
curl -N -X POST http://127.0.0.1:8787/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"command":"(sleep 1; echo late) & echo early; wait; exit 3","stream":true}'
```

```
early
late

[exit 3]
```

## HTTP surface

```
PUT  /c/<name>/file/workspace/<path>   raw body → writeFile at /workspace/<path>
GET  /c/<name>/file/workspace/<path>   octet-stream of /workspace/<path>
                                       (any path outside /workspace returns 400)
POST /c/<name>/exec                    { command | argv, cwd?, stream? }
                                       cwd defaults to /workspace
                                       → JSON { exitCode, stdout, stderr },
                                         or with stream: true, the output as
                                         it is written, then [exit <code>]
```

## Size

Wrangler uploads BusyBox and its initramfs as precompiled wasm modules.
The whole Worker is about 3.4 MB, 1.6 MB compressed.

## Layout

```
examples/kitebuild/
  wrangler.jsonc    Worker + DO, compatibility flags and the wasm rule
  src/index.ts      Worker handler + DO (KitebuildExample)
  src/skills/       Files mounted read-only at /workspace/.agents/skills
```
