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
  return await exec(["npm", "test"], { cwd: "/workspace/app", push: ["**"], pull: ["coverage/**"] });
}
```

It works with any Durable Object that has `ctx.container.exec()`, and with any Linux image.

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

`ExecSandbox` is a base class for the container. It starts the container on the first command
and keeps it running for 10 minutes after the last one. Commands run as root unless the call
names another user. It can also [snapshot](#snapshots) the container once it goes quiet.

```ts
import { ExecSandbox } from "@cloudflare/computer/remote-exec";

export class Sandbox extends ExecSandbox<Env> {
  protected startOptions() {
    return { enableInternet: false }; // what ctx.container.start() takes
  }
}
```

Any Durable Object that implements `exec(cmd, options)` the way `ctx.container.exec()` does
works too. That interface is the `ExecTarget` type.

### 2. Get remote-exec into the container

`remote-exec` runs the commands and syncs the files. The npm package doesn't include it. Get it
in one of two ways, using the same version as `@cloudflare/computer`.

**Copy it into the image** from `ghcr.io/cloudflare/computer-remote-exec`, which is also at
`registry.cloudflare.com/library/computer-remote-exec`. The image has the binary for both
`linux/amd64` and `linux/arm64`, at `/usr/local/bin/remote-exec`:

```dockerfile
FROM ghcr.io/cloudflare/computer-remote-exec:0.10.0 AS remote-exec

FROM debian:stable-slim
COPY --from=remote-exec /usr/local/bin/remote-exec /usr/local/bin/remote-exec
CMD ["sleep", "infinity"]
```

**Or have the Worker carry it.** Download `remote-exec-linux-x86_64` and
`remote-exec-linux-aarch64` from the `@cloudflare/computer@<version>` GitHub release, and check
them against its `SHA256SUMS`. Save them with a `.bin` extension: Wrangler and the Cloudflare Vite
plugin import `.bin` files as bytes. Then pass them as `binaries`, and the module copies the right
one into the container on the first command, and again whenever the container has lost it. This
works with any image that has a POSIX shell and the usual core utilities, and adds about 2.7 MB to
the Worker.

```ts
import { bundledRemoteExec } from "@cloudflare/computer/remote-exec";
import aarch64 from "./remote-exec-linux-aarch64.bin";
import x86_64 from "./remote-exec-linux-x86_64.bin";

const binaries = bundledRemoteExec({ x86_64, aarch64 });
```

Either way, the module checks that the binary speaks its protocol before running anything.
`remote-exec` keeps its state in `/var/lib/remote-exec` and `/run/remote-exec`.

### 3. Register the module

Add `codemode:exec` to the `CodemodeBackend` of the Durable Object that holds the Workspace. The
optional `codemode:remote-exec` module is a streaming `exec()`:

```ts
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createExecModule, FACADE_SOURCE, FACADE_SPECIFIER } from "@cloudflare/computer/remote-exec";

new CodemodeBackend({
  loader: env.LOADER,
  modules: {
    "codemode:exec": createExecModule({
      // One container per Workspace.
      target: () => env.SANDBOX.getByName(ctx.id.toString()),
      fs: () => this.workspace.fs,
      runTimeoutMs: 120_000,
      binaries, // from step 2, if the Worker carries the binary
    }),
    [FACADE_SPECIFIER]: FACADE_SOURCE, // codemode:remote-exec
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
| `runTimeoutMs` | **Required.** How long the calling code can run. Commands still running then are stopped. |
| `binaries` | The builds the Worker carries. Leave it out when the image has `remote-exec`. |
| `env(context)` | Environment every command starts with, under the call's own `env`. |
| `output` | The same value as `new Workspace({ output })`. |
| `readOnly` | For a read-only backend: see [Read-only code](#read-only-code). |
| `workspaceRoot`, `containerRoot` | The directories that map to each other. Both default to `/workspace`. |
| `limits` | `maxFileBytes`, `maxSyncBytes` and `maxSyncFiles`. The defaults are 32 MiB, 512 MiB and 50,000. Files over a limit are skipped and reported. |

## Usage

### `exec(argv, options?)`

`exec()` comes from `codemode:exec`. It resolves once the command has exited and its files have
been pulled back, with `{ exitCode, stdout, stderr, truncated?, sync }`. `argv` runs without a
shell: use `["sh", "-c", "..."]` for pipes and redirects.

| Option | |
| --- | --- |
| `cwd` | Working directory. It defaults to `/workspace`, and Workspace paths are the same in the container. |
| `push` | Globs to copy into the container before the command runs. |
| `pull` | Globs to copy back after it exits, deletions included. |
| `user` | `"uid:gid"`, numeric. Pushed files are owned by this user. |
| `env` | Added over the image's environment. |
| `stdin` | A string. |
| `stdout`, `stderr` | `"ignore"` to drop the stream. |
| `lockTimeoutMs` | How long to wait for another command that pushes or pulls. The default is 60 seconds. |

Rules for push and pull:

- Globs are relative to `cwd`, and follow `.gitignore` rules in both directions.
- Push only sends files the container doesn't already have. It deletes files that an earlier push
  placed and the Workspace no longer has, unless something in the container changed them since.
- Pull brings back only what the command changed.
- File modes are kept. Symlinks that point outside the root are refused.
- Commands that push or pull take turns.

Everything a command starts is stopped when it exits. Long output keeps its tail, and the rest is
saved under the Workspace's `output` settings, with the file named in `truncated`. `sync.pushed`
and `sync.pulled` report what was copied, skipped, deleted or in conflict. A command can't safely
run twice, so a [replayed run](./17_isolate_javascript.md#interrupted-executions) fails at an
`exec()` call instead of running it again.

### Streams: `codemode:remote-exec`

`codemode:remote-exec` exports an `exec()` that returns a process shaped like
`ctx.container.exec()`'s:

```js
import { exec } from "codemode:remote-exec";

const proc = await exec(["node", "server.js"], { push: ["**"], stdin: "pipe" });
const writer = proc.stdin.getWriter();
await writer.write(new TextEncoder().encode("hello\n"));
await writer.close();
for await (const chunk of proc.stdout) console.log(new TextDecoder().decode(chunk));
console.log(await proc.exitCode);
```

The process has `pid`, `stdin`, `stdout`, `stderr`, `exitCode`, `pushed`, `pulled`, `truncated`,
`output()` and `kill(signal?)`. This `exec()` also takes `signal`, an `AbortSignal` that kills
everything the command started and skips the pull, and `stderr: "combined"`.

A stream that's being read holds the command back once its read-ahead is full, as a pipe does. If
code stops reading it for 30 seconds (`createExecModule({ streamStallMs })`), it stops streaming
and stops holding the command back, so `exitCode` still resolves. Long output is still saved, as
`truncated` reports, and reading the stream again fails, saying why. Cancel a stream you're done
with (`break` out of a `for await` does) to let the command go at once.

### Read-only code

`codemode:exec` needs a read-write backend. For code that may only read files, register the
module on a read-only backend with `readOnly: true`. Commands then run as `nobody` (65534:65534)
with no capabilities, pushed files stay owned by root so commands can read them but not change
them, and `pull` and `user` are refused.

### Routing the container's network

Override `outbound()` on `ExecSandbox` to send all of the container's HTTP and HTTPS through a
`Fetcher`, such as an entrypoint of your Worker. The container then trusts the platform's
intercepting CA, and `enableInternet` is off unless `startOptions()` turns it on. `outbound()`
gets the value the caller passed as `exec()`'s third argument. `withEgress(stub, value)` passes a
value with every command the module runs, so the route can depend on something only the caller
knows, such as credentials to add:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

export class ContainerEgress extends WorkerEntrypoint<Env, { token: string }> {
  override async fetch(request: Request) {
    if (new URL(request.url).hostname !== "api.example.com") return fetch(request);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${this.ctx.props.token}`);
    return fetch(new Request(request, { headers, redirect: "manual" }));
  }
}

export class Sandbox extends ExecSandbox<Env, { token: string }> {
  protected startOptions() {
    return {};
  }
  protected override outbound(egress: { token: string } | undefined) {
    return egress && this.ctx.exports.ContainerEgress({ props: egress });
  }
}

// In createExecModule():
target: () => withEgress(env.SANDBOX.getByName(id), { token }),
```

### Snapshots

Define `snapshot()` on `ExecSandbox` to persist the container, with `snapshotContainer()` or
`snapshotDirectory()`, and have `startOptions()` start from what it recorded:

```ts
import { ExecSandbox, type PlatformContainer } from "@cloudflare/computer/remote-exec";

export class Sandbox extends ExecSandbox<Env> {
  protected startOptions() {
    const id = this.ctx.storage.kv.get<string>("snapshot");
    return id ? { containerSnapshot: { id } } : { image: "base" };
  }
  protected override async snapshot(container: PlatformContainer) {
    const { id } = await container.snapshotContainer!();
    this.ctx.storage.kv.put("snapshot", id);
  }
  protected override snapshotDebounceMs() {
    return 30_000; // default 10_000
  }
}
```

- **Debounced.** `snapshot()` runs once no command has been running or starting for
  `snapshotDebounceMs()`, and only if a command ran since the last snapshot. A command in that
  window restarts the wait, so a call's short gaps, such as between its install check and its
  session, don't trigger one.
- **Commands wait for it.** The platform's `exec()` fails while a snapshot is in progress, so
  commands that arrive then queue and start in order once it finishes. A failed snapshot is
  logged, releases the queue the same way, and is tried again at the next idle.
- **Use `container` in `snapshot()`, not `this.exec()`**, which would wait for the snapshot itself.
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
