# 21. Kitebuild backend

> [!NOTE]
> **Experimental.** `KitebuildBackend` may change in any release. See the [status table](../packages/computer/README.md#status).

`KitebuildBackend` runs shell commands on a Kitebuild machine: the BusyBox userland that busyworker runs inside a Worker by emulating the Linux syscall ABI. Commands are real processes, so pipes, background jobs and signals work, and output streams while a command runs. The machine lives in the Durable Object that owns the Workspace and reads and writes the Workspace store directly, so there is one copy of every file and nothing to sync.

It sits between the Worker shell, which starts fast but runs a fixed command set in a TypeScript interpreter, and the container backend, which is full Linux but starts a container and syncs a second copy of the files.

## Setup

`@cloudflare/kitebuild-core` and `@cloudflare/kitebuild-git` are optional peer dependencies of `@cloudflare/computer`, needed by this backend. Install them next to it:

```ts
import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { KitebuildBackend } from "@cloudflare/computer/backends/kitebuild";

export class Agent extends DurableObject<Env> {
  workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [new KitebuildBackend()],
  });
}
```

The Worker needs `nodejs_compat`. Wrangler uploads BusyBox and its initramfs as precompiled wasm modules, about 1.9 MB together.

```ts
using run = await workspace.runtime.exec("tar xzf src.tgz && ls src | wc -l", {
  cwd: "/workspace",
  encoding: "utf8",
});
for await (const event of run) {
  if (event.name === "stdout") console.log(event.value); // as it is written
}
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `id` | `"kitebuild"` | Selector for `runtime.exec({ backend })`. |
| `commands` | `[]` | Commands beyond BusyBox, as Kitebuild toolsets (`{ programs, extras? }`). |
| `paths` | `["/workspace"]` | Workspace directories mounted at the same path in the machine. Created when missing. |
| `egress` | `{ mode: "none" }` | Outbound network, as for the other backends. |
| `cacheBytes` | 8 MiB | File bytes cached in memory for reads. |
| `env` | `{}` | Environment every command starts with. |
| `maxExecs` | 4 | Commands running at once; more fail with `EEXEC_BUSY`. |
| `git` | `"kitebuild"` | Which `git` the shell has; see [git](#git). |

Commands beyond BusyBox come from packages the caller installs and passes in `commands`. Each package exports toolsets, Kitebuild's name for a set of programs on the machine's `PATH`. These are shell commands; the tools an agent calls, such as `read` and `exec`, come from [`@cloudflare/computer/tools`](./09_tool_interface.md).

```ts
import { rg, jq } from "@cloudflare/kitebuild-cli-tools";

new KitebuildBackend({ commands: [rg(), jq()] });
```

Commands come in two kinds, and it helps to know which is which. Some are upstream programs built for WebAssembly, such as BusyBox, and `rg` and `jq` from `@cloudflare/kitebuild-cli-tools`; they behave as they do anywhere. Others are Kitebuild's own implementations in JavaScript, such as `node`, `npm`, `tsc`, `vite`, `vitest` and `git`, which cover what builds and tests use rather than every flag; their coverage grows with each Kitebuild release. When one of those meets something it doesn't support, it stops before doing any work, with exit code 3 and a `kitebuild: unsupported: <feature>: <reason>` line on stderr; `KITEBUILD_UNSUPPORTED=warn` in the command's environment keeps going with a warning instead. Each package's README says what its commands cover.

Some commands load their wasm only when first run, through `import.source()`, which needs the `new_module_registry` compatibility flag; each package's README says which. The wasm still counts toward the Worker's upload, so import only the commands you use.

### A fuller setup

This backend has `rg` and `jq`, a second mounted directory, a shared environment, and network access only to GitHub, through a gateway that also adds a token to git's requests:

```ts
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { KitebuildBackend } from "@cloudflare/computer/backends/kitebuild";
import { jq, rg } from "@cloudflare/kitebuild-cli-tools";

export class EgressGateway extends WorkerEntrypoint<Env> {
  override async fetch(request: Request) {
    const host = new URL(request.url).hostname;
    if (host === "github.com" || host === "codeload.github.com") return fetch(request);
    return new Response("blocked by egress policy\n", { status: 403 });
  }
}

export class Agent extends DurableObject<Env> {
  workspace = new Workspace({
    storage: this.ctx.storage,
    defaultGitIdentity: { name: "Agent", email: "agent@example.com" },
    backends: [
      new KitebuildBackend({
        commands: [rg(), jq()],
        paths: ["/workspace"],
        env: { CI: "1", LANG: "C.UTF-8", TZ: "UTC" },
        egress: { mode: "http-gateway", gateway: this.ctx.exports.EgressGateway({}) },
        git: {
          fetch: (request, send) => {
            if (new URL(request.url).hostname === "github.com")
              request.headers.set("authorization", `Bearer ${this.env.GITHUB_TOKEN}`);
            return send(request);
          },
        },
      }),
    ],
  });

  async countTodos(repo: string): Promise<string> {
    using run = await this.workspace.runtime.exec(
      `git clone --depth 1 "$REPO" src && rg --json TODO src | jq -s 'map(select(.type == "match")) | length'`,
      { cwd: "/workspace", env: { REPO: repo }, encoding: "utf8" },
    );
    const { exitCode, stdout, stderr } = await run.result();
    if (exitCode !== 0) throw new Error(stderr);
    return stdout.trim();
  }
}
```

Each command's environment is built in three layers: `HOME=/root`, `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and `TERM=dumb` first, then the backend's `env`, then the command's own `env`. A later layer wins, so setting `PATH` in either replaces the default rather than adding to it. Keep secrets out of `env` when the git `fetch` can add them instead, since every program in the shell can read its environment.

## Built-in commands

### git

`git` is Kitebuild's git (`@cloudflare/kitebuild-git`) by default: isomorphic-git working on the machine's own files, with busyworker's patches for large clones and checkouts. It covers `init`, `clone`, `status`, `log`, `add`, `commit`, `branch`, `checkout`, `remote`, `config`, `fetch`, `pull`, `push`, `apply`, `reset`, `cherry-pick`, `revert`, `blame` and more, and refuses options it does not support by name.

`git push [-u] [-f] [<remote> [<src>[:<dst>]]]` is allowed, with credentials from the environment (for example `GITHUB_TOKEN`) or from your fetch.

As in git, a commit needs an author and committer: from `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, then `user.name` and `user.email` in the repository's config or in `$HOME/.gitconfig` (`git config --global`), then `EMAIL`, then the Workspace's `defaultGitIdentity`. Without any of these, `git commit` exits 128 with git's advice instead of guessing an email, so set `defaultGitIdentity`, pass the identity in the command's `env`, or set it with `git config`.

Its HTTP requests (clone, fetch, push) follow `egress`, like every other command; Kitebuild checks the policy for every request and every redirect it follows. They are refused under `none`, so the default shell has no `git clone`; sent directly under `direct`; and handed to your gateway under `http-gateway`, which can allow only the hosts you choose. To add credentials, pass a fetch that receives each request the policy lets out, sent directly or to the gateway, and sends it on with `send`; it never sees a refused request:

```ts
new KitebuildBackend({
  egress: { mode: "http-gateway", gateway: env.GIT_GATEWAY },
  git: {
    fetch: (request, send) => {
      if (new URL(request.url).hostname === "github.com") request.headers.set("authorization", token);
      return send(request);
    },
  },
});
```


`git: "workspace"` uses the Workspace's git client instead, the same one as `workspace.git` and the Worker shell's `git`. It runs on the host and does not follow `egress`, so `git clone` and `git pull` work even under `none`, as they do in the Worker shell; to add credentials or limit where it connects, give `createGitClient()` a `fetch` (see [Host fetch and authentication](./13_git_interface.md#host-fetch-and-authentication)). Pass `createGitClient()` from `@cloudflare/computer/git` as the Workspace's `git` option to enable it; without it, `git` prints the not-configured message and exits 1. Files the command wrote are committed before each `git` call, and what git writes under the mounted paths is visible to the rest of the command.

### assets and artifacts

The machine has the Worker shell's `assets` and `artifacts` commands, with the same arguments, output and messages. See [Assets](./14_assets_interface.md) and [Artifacts](./15_artifacts_interface.md).

- `assets publish <path> [<expiry>]` publishes a file through the Workspace's assets client and prints the URL. Files the command wrote are committed first, so a file written earlier in the same command is published as it is now. Without an assets client it prints `assets: publishing is not configured for this workspace` and exits 1.
- `artifacts ...` forwards its arguments and environment to the Workspace's Artifacts client. `artifacts create` adds its git remote through the Workspace's git client, outside the machine; the rest of the command sees the change straight away, and files the command already has open stay usable. It uses that client under the default `git: "kitebuild"` too, so on a Workspace without one, `artifacts create` creates the repo and its token and then fails to add the remote. There, use `artifacts repo create` and `artifacts token create`, and add the remote with the shell's own `git remote add`.

A toolset program at `/usr/bin/git`, `/usr/bin/assets` or `/usr/bin/artifacts` replaces the built-in command.

## Files

Paths are the same on both sides: the agent's `/workspace/x` is the shell's `/workspace/x`. Outside `paths`, `/bin` and `/etc` come from the initramfs and `/tmp` is in memory.

Writes from the shell land in the Workspace when the command ends: a new file's row, bytes and mode are committed in one transaction, and up to 16 files are held in dofs write buffers while a command writes them. Writes from the agent made between commands are applied to the machine's tree at the start of the next one, without dropping its cache. Writes the agent makes while a command runs are not visible to that command.

Two behaviours differ from Linux because dofs addresses file bytes by path. A file renamed over or unlinked while a process holds it open can no longer be read through that descriptor, and a write to it fails.

## Network

`egress` maps onto the machine's egress policy:

- `none` refuses every connection with `EACCES` and answers every lookup with `NXDOMAIN`, so commands fail at once.
- `direct` lets TCP connect through `cloudflare:sockets` and DNS go to DNS over HTTPS.
- `http-gateway` sends every connection to the gateway as HTTP requests, by the host name the command asked for. A connection to port 443 is requested as `https://`. Lookups are answered locally, since the gateway routes by name.

JS programs that fetch through Kitebuild's `egressFetch`, as git and the CI applets do, follow the same policy. A toolset that calls the global `fetch` itself is outside it and has to honour the egress setting on its own.

## Limits

The machine shares the Durable Object's memory with the agent. Each process commits its own wasm memory, so keep `maxExecs` and `cacheBytes` modest. There are no listening sockets, and UDP other than DNS fails. There is no `node` or `npm` yet, so `npm install` does not work under any `egress`; run it on the container backend.

A command's output is kept up to 8 MiB. Past that it is dropped, live and on replay, with a note on stderr, and the command runs on to its exit.

`getExec` replays a finished execution from the Workspace database, so a run can be reattached after the Durable Object restarts. The last 64 finished executions are kept for up to an hour. A command still running when the object restarts is lost with its machine, and replays as failed with exit code 1.
