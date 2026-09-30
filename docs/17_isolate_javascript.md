# Isolate JavaScript runtime

`WorkerJavaScriptBackend` runs an ECMAScript module in a fresh Cloudflare Dynamic Worker:

```ts
import { Workspace } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";

const workspace = new Workspace({
  storage: ctx.storage,
  backends: [
    new WorkerJavaScriptBackend({
      loader: env.LOADER,
      root: "/workspace",
      access: "read-write",
      defaultTimeoutMs: 60_000,
      maxTimeoutMs: 180_000,
      globalOutbound: null,
      modules: {
        "math-kit": `export const double = value => value * 2;`,
      },
    }),
  ],
});
```

Execute a module through the common runtime entry point:

```ts
const handle = await workspace.runtime.exec(
  `
    import { double } from "math-kit";
    import fs from "node:fs/promises";

    export default async function main(input) {
      const value = double(input.value);
      await fs.writeFile("/workspace/result.txt", String(value));
      return { value, persisted: await fs.readFile("/workspace/result.txt", "utf8") };
    }
  `,
  {
    backend: "worker-javascript",
    input: { value: 21 },
    encoding: "utf8",
  },
);

const result = await handle.result();
// result.value = { value: 42, persisted: "42" }
```

The source is a real ES module. Static imports, literal dynamic imports, and top-level await are supported. If the module default-exports a function, Workspace invokes it with `options.input`. Otherwise module evaluation completes with a `null` structured result.

`runtime.exec()` returns before the Dynamic Worker finishes: the run keeps advancing while its event stream is consumed and the host call into the Dynamic Worker stays in flight. That pending work keeps the Durable Object resident on its own. A run whose handle is returned but never read can be evicted once the object goes idle; drain the event stream (or `result()`) to keep the run alive, and schedule an alarm through `ctx.storage.setAlarm()` for work that must survive eviction.

## Durable relative imports

Relative imports resolve from `cwd` through the durable Workspace filesystem:

```ts
await workspace.fs.writeFile(
  "/workspace/task.js",
  `
    import fs from "node:fs/promises";
    export default input => fs.writeFile("/workspace/value.txt", String(input.value));
  `,
);

await workspace.runtime.exec(
  `import task from "./task.js"; export default task;`,
  {
    backend: "worker-javascript",
    cwd: "/workspace",
    input: { value: 42 },
  },
);
```

Workspace parses the graph before loading the Worker, confines every durable path, rejects symlink traversal, and enforces aggregate source, module-count, and import-depth limits. Dynamic imports must use string literals.

## Execution limits and retention

The backend admits up to twenty-four executions at a time by default. A concurrent start past that ceiling fails with `EEXEC_BUSY` instead of creating an unbounded number of Dynamic Workers. Adjust `maxConcurrentExecutions` after measuring the Durable Object and Worker Loader limits for the deployment.

Each execution also bounds combined stdout and stderr output, active event subscribers, directory entries per read, concurrent and total capability calls, and cumulative capability request and response bytes. The corresponding `maxStdioBytes`, `maxExecutionSubscribers`, `maxDirectoryEntries`, and `max*Capability*` options may be lowered for public workloads. Directory reads apply their limit in SQLite before materializing rows. Requests are checked inside the isolate before Workers RPC and again by the host.

Completed execution records remain available for replay for sixty minutes by default. The backend also keeps at most 100 completed records. Configure these bounds with `retentionMs` and `maxRetainedExecutions`. Completed records leave the in-memory active set immediately; replay reads them from SQLite.

Cancellation stops new host capability calls, disposes the Dynamic Worker, and waits for host calls that were already accepted. Exit 130 is published only after those calls settle. Normal completion uses the same drain rule, so an unawaited capability call cannot mutate the workspace after exit 0.

Host calls have a caller-visible deadline, controlled by `maxHostCallMs` and defaulting to `maxTimeoutMs`. Missing the deadline fails the capability call and marks the execution failed, even if caller code catches that error. Execution still waits for the accepted host operation itself before publishing a terminal event because many host APIs cannot roll back an external side effect after dispatch. Host module functions receive a `signal` in their context and must stop promptly when it aborts. A host module that ignores cancellation and never settles will keep execution in its finalizing state. `compatibilityDate` and `compatibilityFlags` control the Dynamic Worker runtime and default to the package-tested settings.

## Environment, standard input, and the `process` shim

Each execution installs a small `node:process` shim so ordinary module code can read its environment and standard streams. The shim exposes only what the caller supplies for that execution; the host environment is never visible.

`process.env` is a snapshot of the `env` record passed on the exec options. Values the caller does not pass are absent, and the Durable Object's own environment is never merged in, so a module cannot read host bindings or secrets through `process.env`.

`process.stdin` is a non-interactive async-iterable over the caller-supplied `stdin` bytes. The caller passes `stdin` as a `Uint8Array` or string on the exec options; `for await` yields the bytes once and then ends, and there is no blocking read for further input because an evaluate-once execution has no session to wait on. `isTTY` is `false`. The supplied input is bounded by `maxStdinBytes`; exceeding it fails the run with a clear error.

`process.stdout` and `process.stderr` are writable streams whose writes flow to the live output described under Isolation and lifecycle. `console.log` and `console.info` route to standard output, `console.warn` and `console.error` route to standard error, and both share the single `maxStdioBytes` ceiling. `process.argv`, `process.cwd()`, and `process.platform` return inert values: `cwd()` reflects the execution's working directory, while `argv` and `platform` carry fixed placeholders rather than describing the host process.

```ts
const handle = await workspace.runtime.exec(
  `
    export default async function main() {
      let piped = "";
      for await (const chunk of process.stdin) piped += new TextDecoder().decode(chunk);
      console.log("received", piped.length, "bytes");
      return { who: process.env.WHO, piped };
    }
  `,
  {
    backend: "worker-javascript",
    env: { WHO: "demo" },
    stdin: "hello",
    encoding: "utf8",
  },
);
```

## Modules

Caller source can import three kinds of module, and all of them are fixed when the backend is constructed:

| Kind | Configured with | Runs in | Example |
| --- | --- | --- | --- |
| Built in | Always installed | The isolate, backed by the Workspace | `node:fs`, `node:fs/promises` |
| Source | `modules: { name: "source" }` | The isolate | a bundled library |
| Host | `modules: { "ws:name": { fn } }`, or a factory | The Durable Object | `ws:git`, `ws:container`, your own |

```ts
import { createArtifactsModule } from "@cloudflare/computer/modules/artifacts";
import { createContainerModule } from "@cloudflare/computer/modules/container";
import { createGitModule } from "@cloudflare/computer/modules/git";

new WorkerJavaScriptBackend({
  loader: env.LOADER,
  modules: {
    "tar-stream": TAR_STREAM_BUNDLE,
    "ws:git": createGitModule(),
    "ws:artifacts": createArtifactsModule(),
    "ws:container": createContainerModule(),
    "ws:weather": {
      forecast: ([city]) => lookUpForecast(String(city)),
    },
  },
});
```

An import that is not built in, configured, or a relative Workspace path fails before the Worker is created. Caller source and durable files cannot shadow a configured or built-in module.

The backend describes its modules for a model in `backend.description`, and the `exec` tool shows that text, so the list the model reads always matches what is installed:

```text
`command` is ECMAScript module source, run in an isolated JavaScript runtime. Relative imports resolve from `cwd` in the workspace.
Code has no direct network access.

Modules code can import:
- `node:fs/promises` (also `node:fs`): the workspace's files. ...
- `tar-stream`: a bundled library.
- `ws:git`: The workspace's Git repository tools: `status({ dir })`, ...
- `ws:container`: Runs shell commands in a full Linux container that shares this workspace's files. ...
- `ws:weather`: exports `forecast`.
```

A factory adds its own text through a `description` property, as the prebuilt modules do. An object of functions is listed by its export names; say more about it in the `exec` tool's backend description if the model needs it.

### Built-in filesystem

Filesystem access uses the familiar asynchronous Node API, but is backed by the durable Workspace rather than an isolate-local filesystem. Both forms are installed automatically:

```js
import fs from "node:fs/promises";
// or: import { promises as fs } from "node:fs";

const text = await fs.readFile("/workspace/input.txt", "utf8");
await fs.writeFile("/workspace/output.txt", text.toUpperCase());
```

Supported promise APIs are `readFile`, `writeFile`, `mkdir`, `rm`, `chmod`, `symlink`, `readlink`, `readdir`, `stat`, `lstat`, and `access`. `readFile` returns bytes when encoding is omitted and supports `"utf8"` / `"utf-8"` for text; other encodings are rejected. `writeFile` supports the default `"w"` flag and exclusive `"wx"`; other Node flags are rejected, and—as in Node—the parent directory must already exist. Relative symlink targets are preserved by `readlink`, while reads and writes through symlinks are rejected by the Workspace confinement boundary. Synchronous and callback-style Node filesystem APIs are intentionally unavailable because every operation crosses the isolate-to-Workspace capability boundary.

Path confinement rejects lexical escapes and every symlink component before an operation. These checks are not an atomic inode-style “resolve beneath root” primitive: do not treat one isolate capability as a security boundary against a separate, more privileged principal concurrently replacing paths in the same mutable Workspace. Deployments requiring that adversarial concurrency need a future transactional DOFS primitive or separate Workspace identities.

### Source modules

A string value is JavaScript source installed as a bare import, such as a bundled library. It is plain code with no host access, and it cannot use the `ws:` namespace or replace `node:fs` or `node:fs/promises`.

### Host modules

A host module runs in the Durable Object, and each of its functions becomes a named export in the isolate. Host modules must use a simple `ws:*` specifier. Nothing under `ws:` is installed unless you configure it.

Pass an object of functions:

```ts
modules: {
  "ws:weather": {
    forecast: ([city]) => lookUpForecast(String(city)),
  },
}
```

When the functions need the Workspace's Git client, Artifacts client, or runtime, pass a factory instead. The backend calls it once when it connects to its Workspace. This is how the prebuilt modules work:

```ts
modules: {
  "ws:repo": (host) => ({
    async recent(args, context) {
      const dir = await context.resolvePath(String(args[0] ?? "."));
      return host.git.log({ dir, depth: 5 });
    },
  }),
}
```

```js
import { recent } from "ws:repo";
export default () => recent("/workspace/app");
```

Each function receives the arguments the isolate passed, as an array of JSON-compatible values, and a context:

| Field | Meaning |
| --- | --- |
| `signal` | Aborts when the call passes its deadline or the execution is cancelled. |
| `deadline` | Epoch milliseconds after which the isolate stops waiting. |
| `access` | The backend's `"read"` or `"read-write"` access. Check it before any write. |
| `resolvePath(path, { allowMissing })` | Confines a caller path to the backend root and rejects symlinks. |

The arguments come from caller code, so parse them before use. A function may return a value or a promise. The result must be JSON-compatible, and the bridge checks it at runtime: `undefined` becomes `null` and `undefined` object fields are dropped, as with `JSON.stringify`. It fits within the same capability byte limits as every other host call. A function that ignores `signal` and never settles keeps the execution in its finalizing state.

Specifiers and the export names of an object are checked at construction. A factory's export names are checked when the backend connects and the factory runs. A module must export at least one function, and every export name must be a JavaScript identifier name other than `default` or `then`. A reserved word such as `delete` is allowed, and caller code renames it on import: `import { delete as remove } from "ws:files"`. Importing a name the module does not export fails when the module graph links, before any code runs.

### `ws:git`

```js
import { clone, diff, status, log, cli } from "ws:git";
```

`createGitModule()` from `@cloudflare/computer/modules/git` wraps the Workspace's Git client. Every `dir` and `cwd` is confined to the backend root, `clone` and `cli` need a read-write backend, and `cli` rejects `-C`, `--git-dir`, and `--work-tree`. Clone, fetch, pull, push, `ls-remote`, and submodule commands run from the host, even when the Dynamic Worker has `globalOutbound: null`, so they are denied unless you pass `createGitModule({ allowNetwork: true })`.

### `ws:artifacts`

```js
import { create, get, list, importArtifact, deleteArtifact } from "ws:artifacts";
```

`createArtifactsModule()` from `@cloudflare/computer/modules/artifacts` wraps the Workspace's Artifacts client. Calls that change Artifacts need a read-write backend. `importArtifact()` fetches from a caller-chosen URL on the host, so it is denied unless you pass `createArtifactsModule({ allowNetwork: true })`. Every call fails clearly when no Artifacts binding is configured.

### `ws:container`

`createContainerModule()` from `@cloudflare/computer/modules/container` lets JavaScript run shell commands in the Workspace's container backend. With it, JavaScript is the only backend the model sees, and the container is something that JavaScript can call:

```ts
this.workspace = new Workspace({
  storage: ctx.storage,
  backends: [
    new WorkerJavaScriptBackend({
      loader: env.LOADER,
      access: "read-write",
      modules: { "ws:container": createContainerModule() },
    }),
    new CloudflareContainerBackend({ /* ... */ }),
  ],
});

const tools = createAITools({
  workspace: this.workspace,
  shell: { backends: { "worker-javascript": {} } },
});
```

```js
import { exec } from "ws:container";

export default async function () {
  const { exitCode, stdout, stderr } = await exec("npm test", { cwd: "/workspace/app" });
  return { passed: exitCode === 0, stdout, stderr };
}
```

`exec(command, { cwd, env, stdin, timeoutMs })` runs through `workspace.runtime.exec` on the container backend (`"container-shell"` unless you pass `backend`). The container shares the Workspace's files: writes the module made before the call are pushed to the container, and the container's changes are pulled back before `exec` returns. A non-zero exit code comes back as a value, not as an error.

A few limits follow from `exec` being a host call:

- Output comes back when the command finishes, not while it runs. Each stream is cut at `maxOutputBytes` (64 KiB by default), which must stay well under the backend's `maxCapabilityBytes`.
- The command's timeout is capped at the time left before the host call deadline (`maxHostCallMs`, which defaults to `maxTimeoutMs`). Raise `defaultTimeoutMs`, `maxTimeoutMs`, and `maxHostCallMs` for slow installs and builds, and remember the container's first start.
- Cancelling the execution kills the running command.

A container command can write to the Workspace and reach the network, whatever the JavaScript backend's egress settings say. `exec` refuses to run on a read-only backend.

## Isolation and lifecycle

Each execution receives a fresh Dynamic Worker with:

- explicit Worker Loader CPU limits;
- a host wall-clock deadline;
- `globalOutbound: null` by default;
- finite, acyclic JSON-compatible input and structured result validation;
- configurable source/module graph, input, result, stdin, stdio, file/capability request, and response byte limits (`maxSourceBytes`, `maxInputBytes`, `maxResultBytes`, `maxStdinBytes`, `maxStdioBytes`, and `maxCapabilityBytes`);
- explicit entrypoint and Worker disposal;
- host-owned cancellation;
- retained events and result rows in the Workspace database.

Standard output and standard error stream live. The Dynamic Worker hands the readable end of its output stream to the host through the `attachOutput` bridge call, and the host drains it frame by frame while user code is still running, appending each chunk to the execution event stream as it arrives rather than buffering the run and publishing at the end. The structured result and the exit event settle once the output stream closes, so the terminal events always follow the last output. Output remains bounded by `maxStdioBytes` across both streams. Completed writes are durable immediately. Failure or cancellation does not roll back filesystem effects already completed.
