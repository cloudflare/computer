# 20. Remote exec

> [!WARNING]
> **Experimental.** `@cloudflare/computer/remote-exec` and the `remote-exec` binary may change in
> any release. See the [status table](../packages/computer/README.md#status).

> [!NOTE]
> This doc reflects shipped code in `packages/computer/src/remote-exec/` and
> `packages/remote-exec/`. The example lives at
> [`examples/remote-exec`](../examples/remote-exec).

Remote exec lets code running on a [`CodemodeBackend`](./17_isolate_javascript.md) run commands
in a container. Before a command runs, the Workspace files it names are pushed into the container.
After it exits, the files it changed are pulled back:

```js
import { exec } from "codemode:exec";

export default async function () {
  const proc = await exec(["npm", "test"], { cwd: "/workspace/app", push: ["**"], pull: ["coverage/**"] });
  const { exitCode, stdout, sync } = await proc.output();
  return { exitCode, stdout: new TextDecoder().decode(stdout), pulled: sync.pulled.files };
}
```

`exec()` returns a process shaped exactly like `ctx.container.exec()`'s, with streams, an exit code,
`output()` and `kill()`. It works with any Durable Object that has `ctx.container.exec()`, and with any Linux image.

## When to reach for it

| | `codemode:exec` (remote exec) | `codemode:container` |
| --- | --- | --- |
| Container | Any image, in a Durable Object you own | The Workspace's [container backend](./16_code_execution.md), running `computerd` |
| Files | Pushed before each command and pulled after it, chosen by globs | Kept in sync continuously over FUSE |
| Inside the container | One static binary, `remote-exec` | `computerd`, FUSE and the sync protocol |
| Output | Streams, like `ctx.container.exec()` | The whole result |

Choose remote exec when you already have a container image or want to keep it simple, and when
each command touches a known set of files. Choose the container backend when the container
should see the whole Workspace all the time.

## Setup

### 1. A container Durable Object

`executor()` runs commands in a Durable Object's container. It starts the container on the first
command, with the options `ctx.container.start()` takes, and keeps it running for 10 minutes
after the last one. Commands run as root unless the call names another user.

```ts
import { DurableObject } from "cloudflare:workers";
import { type ExecArgs, executor } from "@cloudflare/computer/remote-exec";

export class Sandbox extends DurableObject<Env> {
  #executor = executor(this, { enableInternet: false });

  exec(...args: ExecArgs) {
    return this.#executor.exec(...args);
  }
}
```

The `exec()` method is what the module calls. Workers RPC reaches only the methods a class
declares, never its fields, so the executor can't be called through the field alone.

The start options can also be a function, called each time the container starts, for example to
start from a [snapshot](#snapshots). A third argument takes hooks: `outbound` and `egressKey` to
[route the network](#routing-the-containers-network), `snapshot` and `snapshotDebounceMs`,
`inactivityTimeoutMs`, `user`, `onIdle` and `onStopped`. The executor also has `destroy()`, which
stops the container.

`ExecSandbox` is the same thing as a base class, with methods to override instead of hooks. Any
Durable Object that implements `exec(cmd, options)` the way `ctx.container.exec()` does works too.
That interface is the `ExecTarget` type.

### 2. Get remote-exec into the container

`remote-exec` runs the commands and syncs the files. The npm package doesn't include it. Get it
in one of two ways, using the same version as `@cloudflare/computer`.

**Copy it into the image** from `ghcr.io/cloudflare/computer-remote-exec`, which is also at
`registry.cloudflare.com/library/computer-remote-exec`. The image has the binary for both
`linux/amd64` and `linux/arm64`, at `/usr/local/bin/remote-exec`:

```dockerfile
FROM ghcr.io/cloudflare/computer-remote-exec:0.11.1 AS remote-exec

FROM debian:stable-slim
COPY --from=remote-exec /usr/local/bin/remote-exec /usr/local/bin/remote-exec
CMD ["sleep", "infinity"]
```

**Or have the Worker carry it.** The build for your containers comes from the
`@cloudflare/computer@<version>` GitHub release, checked against its `SHA256SUMS`. Cloudflare runs
containers as `linux/amd64`, and `vite dev` and `wrangler dev` build them that way, so that's
`remote-exec-linux-x86_64`, about 1.5 MB. Pass it as `binaries`, and the module copies it into the
container on the first command, and again whenever the container has lost it. This works with any
image that has a POSIX shell and the usual core utilities. A container of an architecture the
Worker has no build for fails with an error that names it.

With Vite, `remoteExec()` from `@cloudflare/computer/vite` does all of this. It downloads the build
from the release that matches the installed package, checks it, and caches it, so only the first
build downloads it. It serves it as `computer:remote-exec`:

```ts
// vite.config.ts
import { remoteExec } from "@cloudflare/computer/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default { plugins: [cloudflare(), remoteExec()] };
```

```ts
import binaries from "computer:remote-exec";

createExecModule({ binaries, ... });
```

`vite build` puts the build beside the Worker, where `wrangler deploy` uploads it as a module of its
own, and the Worker streams it from `/bundle` with `node:fs` (it needs `nodejs_compat`). It reads a
chunk at a time to hash it and to copy it in, so the build is never held in memory whole. `vite
dev` doesn't put files under `/bundle`, so there the Worker imports the build instead. The plugin
takes `arch` for the architectures to carry (`x86_64` by default), `version` for another release,
and `builds` for a directory of local builds. For TypeScript, add
`"@cloudflare/computer/vite/client"` to `compilerOptions.types`. The plugin needs
`@cloudflare/vite-plugin` 1.68.0 or later, whose workerd keeps a container's `exec()` streams open
until they finish.

With Wrangler, download the build yourself, upload it as a module of its own, and stream it with
`fileRemoteExec()`. workerd shows the module under `/bundle` by its path relative to `base_dir`.
Importing it would rename it to a content hash, and hold it in memory:

```jsonc
// wrangler.jsonc, with the build saved as bin/remote-exec. base_dir is bin/ alone: a wider
// directory has wrangler upload, and watch, everything its default rules match (*.txt, *.bin).
"base_dir": "bin",
"find_additional_modules": true,
"rules": [{ "type": "Data", "globs": ["remote-exec"], "fallthrough": false }]
```

```ts
import { fileRemoteExec } from "@cloudflare/computer/remote-exec";

const binaries = fileRemoteExec({ x86_64: "/bundle/remote-exec" });
```

Where neither works, import the build as bytes with `bundledRemoteExec()`. Wrangler and the Vite
plugin import `.bin` files as `Data` modules, which stay in memory for the isolate's life:

```ts
import { bundledRemoteExec } from "@cloudflare/computer/remote-exec";
import x86_64 from "./remote-exec-linux-x86_64.bin";

const binaries = bundledRemoteExec({ x86_64 });
```

Either way, the module checks that the binary speaks its protocol before running anything.
`remote-exec` keeps its state in `/var/lib/remote-exec` and `/run/remote-exec`.

### 3. Register the module

Add `codemode:exec` to the `CodemodeBackend` of the Durable Object that holds the Workspace:

```ts
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createExecModule } from "@cloudflare/computer/remote-exec";

new CodemodeBackend({
  loader: env.LOADER,
  modules: {
    "codemode:exec": createExecModule({
      // One container per Workspace.
      target: () => env.SANDBOX.getByName(ctx.id.toString()),
      fs: () => this.workspace.fs,
      binaries, // from step 2, if the Worker carries the binary
    }),
  },
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 120_000,
});
```

`wrangler.jsonc` needs the two Durable Objects, the container, and the Worker Loader for codemode:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "worker_loaders": [{ "binding": "LOADER" }],
  "containers": [{ "class_name": "Sandbox", "image": "./Dockerfile" }],
  "durable_objects": {
    "bindings": [
      { "name": "SANDBOX", "class_name": "Sandbox" },
      { "name": "WORKSPACE", "class_name": "WorkspaceObject" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox", "WorkspaceObject"] }]
}
```

| `createExecModule()` option | |
| --- | --- |
| `target(context)` | **Required.** The container to run on. Gets the host call's context, so it can choose a container for each run. |
| `fs()` | **Required.** The Workspace's filesystem. |
| `binaries` | The builds the Worker carries. Leave it out when the image has `remote-exec`. |
| `env(context)` | Environment every command starts with, under the call's own `env`. |
| `output` | The same value as `new Workspace({ output })`. |
| `readOnly` | For a read-only backend: see [Read-only code](#read-only-code). |
| `description` | What the model reads about the module, in place of `EXEC_DESCRIPTION`. Build on it to add notes about your containers: `` `${EXEC_DESCRIPTION} Commands time out after 2 minutes.` ``. |
| `workspaceRoot`, `containerRoot` | The directories that map to each other. Both default to `/workspace`. |
| `limits` | `maxFileBytes`, `maxSyncBytes` and `maxSyncFiles`. The defaults are 32 MiB, 512 MiB and 50,000. Files over a limit are skipped and reported. |

## Usage

### `exec(argv, options?)`

`exec()` comes from `codemode:exec`. It starts the command and resolves with its process, shaped
exactly like the one `ctx.container.exec()` returns. `argv` runs without a shell: use
`["sh", "-c", "..."]` for pipes and redirects.

The options are `ctx.container.exec()`'s, plus three of remote exec's own:

| Option | |
| --- | --- |
| `cwd` | Working directory. It defaults to `/workspace`, and Workspace paths are the same in the container. |
| `env` | Added over the image's environment. |
| `user` | `"uid:gid"`, numeric. Pushed files are owned by this user. |
| `stdin` | `"pipe"` for a writable `stdin`, a string to give the command as its input, or a `ReadableStream` to read its input from. |
| `stdout` | `"pipe"` (the default) or `"ignore"`. |
| `stderr` | `"pipe"` (the default), `"ignore"`, or `"combined"` to send it to stdout. |
| `signal` | An `AbortSignal`. Aborting it SIGKILLs everything the command started and skips the pull. |
| `push` | Globs to copy into the container before the command runs. |
| `pull` | Globs to copy back after it exits, deletions included. |
| `lockTimeoutMs` | How long to wait for another command that pushes or pulls. The default is 60 seconds. |

`pty` is refused: remote exec has no pty.

The process has the platform's members:

| Member | |
| --- | --- |
| `pid` | The command's process id. |
| `isPty` | Always `false`. |
| `stdin` | A `WritableStream` with `stdin: "pipe"`, otherwise `null`. |
| `stdout`, `stderr` | `ReadableStream`s of bytes, or `null` for an ignored or combined stream. |
| `exitCode` | A promise of the exit code. It resolves after the pull, so the pulled files are in the Workspace by then. |
| `output()` | Waits for the command and resolves with `{ stdout, stderr, exitCode }`, the output as `ArrayBuffer`s, plus `truncated` and `sync`. |
| `kill(signal?)` | Sends a signal, `SIGTERM` (15) by default, to everything the command started. |
| `resize()` | Refused: there's no pty. |

The streams are the command's pipes, not copies:

- **`exitCode` waits for the pipes.** It resolves, and each stream ends, only once both stdout and
  stderr have been read to the end or cancelled, as on the platform. Read the streams together, call
  `output()`, and cancel or `"ignore"` what you don't need.
- **A full pipe blocks.** A command whose pipe nobody reads stops once the pipe fills.
- **`output()` reads the same pipes.** It can be called once, and only before either stream has
  been read. After it, the streams can't be read.

```js
import { exec } from "codemode:exec";

const proc = await exec(["sh", "-c", "tr a-z A-Z"], { stdin: "pipe", stderr: "ignore" });
const writer = proc.stdin.getWriter();
await writer.write(new TextEncoder().encode("hello\n"));
await writer.close();
for await (const chunk of proc.stdout) console.log(new TextDecoder().decode(chunk));
console.log(await proc.exitCode);
```

`output()` keeps each stream's tail under the Workspace's `output` settings. It saves the rest under
the Workspace's `output` directory, and names the file in `truncated`. `sync.pushed` and
`sync.pulled` report what was copied, skipped, deleted or in conflict. A caller that streams the
output can't call `output()`, so it doesn't get these reports; the pull still happens before
`exitCode` resolves.

Rules for push and pull:

- Globs are relative to `cwd`, and follow `.gitignore` rules in both directions.
- Push only sends files the container doesn't already have. It deletes files that an earlier push
  placed and the Workspace no longer has, unless something in the container changed them since.
- Pull brings back only what the command changed.
- File modes are kept. Symlinks that point outside the root are refused.
- Commands that push or pull take turns.

Everything a command starts is stopped when it exits.

### When the code ends

The process belongs to the code that started it. When that code ends, or pauses in
`ctx.interrupt()`, or releases the process early with `using` or `Symbol.dispose`, a command
still running is SIGKILLed and its pull skipped. Any pipe left unread is drained, so the command's
session ends and the root's lock is freed.

The process works in [replayable runs](./17_isolate_javascript.md#interrupted-executions) too.
Every call it makes is journaled, so a replay gives the same output and exit code without running
anything. A command can't run twice safely, so a run interrupted during `exec()` itself fails
rather than run it again. After a replay, a call the journal doesn't hold finds the command gone, since
it was stopped when the run paused or the Durable Object restarted, and fails saying so.

### Read-only code

`codemode:exec` needs a read-write backend. For code that may only read files, register the
module on a read-only backend with `readOnly: true`. Commands then run as `nobody` (65534:65534)
with no capabilities, pushed files stay owned by root so commands can read them but not change
them, and `pull` and `user` are refused.

### Routing the container's network

Give the executor an `outbound` hook to send all of the container's HTTP and HTTPS through a
`Fetcher`, such as an entrypoint of your Worker. The container then trusts the platform's
intercepting CA, and `enableInternet` is off unless the start options turn it on. `outbound`
gets the value the caller passed as `exec()`'s third argument. `withEgress(stub, value)` passes a
value with every command the module runs, so the route can depend on something only the caller
knows, such as credentials to add:

```ts
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { type ExecArgs, executor, withEgress } from "@cloudflare/computer/remote-exec";

export class ContainerEgress extends WorkerEntrypoint<Env, { token: string }> {
  override async fetch(request: Request) {
    if (new URL(request.url).hostname !== "api.example.com") return fetch(request);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${this.ctx.props.token}`);
    return fetch(new Request(request, { headers, redirect: "manual" }));
  }
}

export class Sandbox extends DurableObject<Env> {
  #executor = executor<{ token: string }>(this, {}, {
    outbound: (egress) => egress && this.ctx.exports.ContainerEgress({ props: egress }),
  });

  exec(...args: ExecArgs<{ token: string }>) {
    return this.#executor.exec(...args);
  }
}

// In createExecModule():
target: () => withEgress(env.SANDBOX.getByName(id), { token }),
```

A container has one route for all its processes, so it's routed for one egress at a time:

- Commands whose egress is the same (`egressKey`, by default equal JSON for plain data) share the
  route.
- A command with a different egress re-routes the container when nothing else is running there.
  While commands from the current route still run, it's refused rather than handed their
  credentials, or they its.
- A command with no egress is refused on a routed container. It's also refused on a container
  that was already running when the Durable Object started, since how that one is routed isn't
  known; a command with an egress re-routes it, and `destroy()` starts it afresh.
- An egress that isn't plain data, such as a stub, has no key by default, so each command with one
  needs the container to itself. Give an `egressKey` hook when something in it identifies the
  caller.

Give each tenant or credential its own container (`getByName()`) when they run commands at once.

### Snapshots

Give the executor a `snapshot` hook to persist the container, with `snapshotContainer()` or
`snapshotDirectory()`, and start options that start from what it recorded:

```ts
import { DurableObject } from "cloudflare:workers";
import { type ExecArgs, executor } from "@cloudflare/computer/remote-exec";

export class Sandbox extends DurableObject<Env> {
  #executor = executor(
    this,
    () => {
      const id = this.ctx.storage.kv.get<string>("snapshot");
      return id ? { containerSnapshot: { id } } : { image: "base" };
    },
    {
      snapshot: async (container) => {
        const { id } = await container.snapshotContainer!();
        this.ctx.storage.kv.put("snapshot", id);
      },
      snapshotDebounceMs: 30_000, // default 10_000
    },
  );

  exec(...args: ExecArgs) {
    return this.#executor.exec(...args);
  }
}
```

- **Debounced.** The hook runs once no command has been running or starting for
  `snapshotDebounceMs`, and only if a command ran since the last snapshot. A command in that
  window restarts the wait, so a call's short gaps, such as between its install check and its
  session, don't trigger one.
- **Commands wait for it.** The platform's `exec()` fails while a snapshot is in progress, so
  commands that arrive then queue and start in order once it finishes. A failed snapshot is
  logged, releases the queue the same way, and is tried again at the next idle.
- **Use `container` in the hook, not `exec()`**, which would wait for the snapshot itself.
- **`destroy()` waits** for a snapshot in progress and drops one that hasn't started.
- **The wait is held in memory.** If the Durable Object is evicted before it ends, that snapshot is
  skipped until the next idle.

## How it works

Each command uses two `exec()` calls in the container:

1. `remote-exec session` is the control channel. It speaks Cap'n Proto over stdin and stdout. The
   Worker uses it to take the lock, push the files and prepare the command.
2. `remote-exec run` hands its own stdin, stdout and stderr to the session, which starts the
   command on them. Output streams straight from the platform, and `run` exits with the command's
   status.

After the command exits, the session reports what changed and the Worker pulls those files.
Each command runs in its own session and process group, and anything still running when it exits
is stopped. If the Worker goes away, the session kills the command.

You can also call the protocol directly from a Durable Object, without codemode, using
`remoteExec(config, argv, options)`. It returns a process with raw streams. Call
`ensureRemoteExec()` first to install or check the binary.
