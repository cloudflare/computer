# Isolate JavaScript runtime

> [!NOTE]
> **Stable.** `WorkerJavaScriptBackend` and its host modules are
> suitable for production use, except `ws:container`, which runs on the
> experimental container backend. See the [status table](../packages/computer/README.md#status).

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

`root`, `/workspace` by default, confines every path isolate code touches. A new Workspace doesn't have that directory yet, so a read-write backend creates it the first time it runs.

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

The source is a real ES module, with static imports and literal dynamic imports. The module needs a default export, or the run fails before it starts. A default-exported function is called with `options.input`, and any other default value is the result. To run code that's already in a file, re-export it with `export { default } from "./main.js"`.

Put the module's work in that function. Each run loads the module first, then calls its default export, and the Workers runtime doesn't allow I/O while a module loads. So `node:fs` and host module calls only work once the function is running:

```js
import fs from "node:fs/promises";

// Fails: this runs while the module loads.
const early = await fs.readFile("/workspace/a.txt", "utf8");

export default async function () {
  // Works: this runs when Workspace calls the function.
  return fs.readFile("/workspace/a.txt", "utf8");
}
```

A call made while the module loads fails the run with an error that names the call, even if the code catches the error, since the work it asked for never happened. The run also fails if a promise rejects and nothing has handled it by the time the function finishes. Top-level `await` is fine for anything that doesn't do I/O.

The returned value becomes the result's `value` and must be JSON-compatible plain data. As with `JSON.stringify`, an `undefined` object field is left out, so `{ kept: 1, dropped: undefined }` completes as `{ kept: 1 }`, and returning `undefined` gives `null`. A function, a class instance such as a `Date`, an `undefined` array item, or a cycle fails the run. `options.input` is checked the same way.

`runtime.exec()` returns before the Dynamic Worker finishes, and the run keeps going whether or not anything reads its event stream. [Long-running executions](#long-running-executions) covers how long a run can last.

## Durable imports

Relative imports resolve from the importing file, as in Node, and absolute imports such as `/workspace/lib/util.js` resolve from the Workspace root. Both read through the durable Workspace filesystem, and the entry source sits in `cwd`:

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

Workspace parses the graph before loading the Worker, confines every durable path, absolute ones included, to the backend root, rejects symlink traversal, and enforces aggregate source, module-count, and import-depth limits. Dynamic imports must use string literals.

## Execution limits and retention

The backend does not cap concurrent executions itself. The platform limits how many Dynamic Workers run at once, and an execution started past that limit fails with the platform's error.

Each execution also bounds combined stdout and stderr output, active event subscribers, directory entries per read, concurrent and total capability calls, and cumulative capability request and response bytes. The corresponding `maxStdioBytes`, `maxExecutionSubscribers`, `maxDirectoryEntries`, and `max*Capability*` options may be lowered for public workloads. Directory reads apply their limit in SQLite before materializing rows. Requests are checked inside the isolate before Workers RPC and again by the host. Every capability call goes through one host bridge that enforces these limits. Values cross as real Workers RPC values, measured as UTF-8 bytes for strings and raw bytes for byte arrays, and anything that is not plain data, such as a function, an RPC stub, or a cycle, is rejected before the host acts on it.

Completed execution records remain available for replay for sixty minutes by default. The backend also keeps at most 100 completed records. Configure these bounds with `retentionMs` and `maxRetainedExecutions`. Completed records leave the in-memory active set immediately; replay reads them from SQLite.

Cancellation stops new host capability calls, disposes the Dynamic Worker, and waits for host calls that were already accepted. Exit 130 is published only after those calls settle. Normal completion uses the same drain rule, so an unawaited capability call cannot mutate the workspace after exit 0.

Host calls have a caller-visible deadline, controlled by `maxHostCallMs` and defaulting to `maxTimeoutMs`. Missing the deadline fails the capability call and marks the execution failed, even if caller code catches that error. Execution still waits for the accepted host operation itself before publishing a terminal event because many host APIs cannot roll back an external side effect after dispatch. Host module functions receive a `signal` in their context and must stop promptly when it aborts. A host module that ignores cancellation and never settles will keep execution in its finalizing state. `compatibilityDate` and `compatibilityFlags` control the Dynamic Worker runtime and default to the package-tested settings.

## Long-running executions

An execution runs until its code returns or its timeout passes, and `maxTimeoutMs` caps the timeout at 3 minutes by default. Several other limits apply to the whole execution, so a long run reaches them sooner:

| Option | Default | Counts |
|---|---|---|
| `maxCapabilityCalls` | 256 | every filesystem and host module call |
| `maxCapabilityRequestBytes` | 8 MiB | bytes sent to those calls, in total |
| `maxCapabilityResponseBytes` | 8 MiB | bytes returned by those calls, in total |
| `maxStdioBytes` | 1 MiB | standard output and standard error, in total; output past it is dropped |

Raise the ones a long run needs along with the timeout:

```ts
new WorkerJavaScriptBackend({
  loader: env.LOADER,
  maxTimeoutMs: 2 * 60 * 60_000,
  maxCapabilityCalls: 100_000,
  maxCapabilityResponseBytes: 256 * 1024 * 1024,
});
```

`maxHostCallMs` defaults to `maxTimeoutMs`, so it grows with it.

A run also needs its Durable Object to stay in memory, and that depends on the host Worker's compatibility date. From 2026-10-01, each piece of pending work keeps a Durable Object in memory for up to 15 minutes from when it starts. A run that keeps making host calls or printing output keeps renewing that, but a quiet one, such as a run waiting on one slow `fetch`, would be evicted 15 minutes after it started. To cover that case, the backend schedules a timer every `keepAliveIntervalMs` (60 seconds by default) while any run is in flight, and each timer counts as new pending work. A run stops counting once its timeout plus `maxHostCallMs` has passed, even if it is still waiting for a host call to settle. While the timer runs, the object is billed for duration and can't hibernate. The backend reads the host Worker's compatibility flags when it connects and schedules the timer only from 2026-10-01, or with `durable_object_io_tasks_prevent_eviction`. On earlier compatibility dates, pending work and timers don't keep a Durable Object in memory, so no timer is scheduled, and a run that outlives the request that started it is evicted about a minute after that request ends, unless the request awaits the run or the host keeps the object in memory itself, for example with an alarm.

CPU time is limited separately from wall-clock time. Each run's CPU limit is the smaller of its timeout and `maxCpuMs`, which defaults to `maxTimeoutMs`. CPU time adds up over the whole run, however much of it is spent waiting, and Cloudflare currently stops a Dynamic Worker call at about five minutes of CPU whatever the limit. A run that mostly waits on I/O uses little of that and can last hours. A run that computes heavily fails with `Worker exceeded CPU time limit.` once it reaches the cap. Every execution gets a fresh Dynamic Worker and a fresh CPU budget, so heavy work can be split across executions or moved to a container. The platform's subrequest limit, 10,000 by default on the Workers Paid plan, also counts every `fetch` over the whole run. A long run also holds one of the ten Dynamic Workers a Durable Object can have in flight for as long as it lasts.

A deploy or a crash still ends a run. See [Interrupted executions](#interrupted-executions) for what happens next.

## Interrupted executions

A deploy or a crash restarts the Durable Object and ends every run in flight. `onInterrupt` decides what happens to those runs. Set a default on the backend and override it per run:

```ts
const backend = new WorkerJavaScriptBackend({ loader: env.LOADER, onInterrupt: "replay" });

await workspace.runtime.exec(source, { onInterrupt: "fail" });
```

| Policy | After a restart |
|---|---|
| `"fail"` (default) | The run fails with exit 1. |
| `"restart"` | The run starts again from the beginning. Calls it already made run again, and its output repeats after a note on standard error. |
| `"replay"` | The run starts again from the beginning, but every call it already made is answered from a journal instead of running again, and its output isn't repeated. Once it catches up, it carries on live. |

The code being run doesn't need to change for either. `"restart"` and `"replay"` are [experimental](../packages/computer/README.md#status): their behavior and stored data may change in any release, and a run interrupted across such an upgrade fails instead of resuming.

### When a run resumes

Interrupted runs resume when the backend next connects, which the next runtime call such as `exec()` or `getExec()` triggers, as does `workspace.ready({ all: true })`. A caller polling a run or reconnecting to its output does this on its own. Nothing else wakes a Durable Object after a deploy, so a run nobody is waiting on stays interrupted until something calls the object, and fails if its timeout passes first. To resume runs without waiting for traffic, call `workspace.runtime.recover()` from the Durable Object's alarm. The Workspace doesn't set an alarm itself, since a Durable Object only has one.

### How replay works

A replayable run saves its code, input and limits when it starts. Every filesystem call, host module call and `fetch` it makes is written to a journal in SQLite before the run sees the response. On replay, the run starts from the top and gets those responses back from the journal, in the order it first saw them, so a `Promise.race` or a timer racing a call goes the same way.

A replayable run also gets versions of a few APIs that would otherwise differ between attempts:

- `Date.now()`, `new Date()` and `performance.now()` read a clock that gives the same times on replay.
- `setTimeout`, `setInterval`, `scheduler.wait()` and `AbortSignal.timeout()` fire in the same order on replay, without waiting out delays they already waited.
- `Math.random()`, `crypto.getRandomValues()` and `crypto.randomUUID()` return the same values, from a random seed saved with the run.
- `fetch` goes through the host, under the backend's egress policy, so a replay doesn't send a request again.

A replay has to take the same path as the first attempt: the same calls, with the same arguments, printing the same output. If it doesn't, the run fails with a message saying where it went differently. Everything saved for a run is deleted when it settles.

### Calls that mustn't run twice

A call still running when the object restarted never returned, so the replay runs it again. Each host module call gets a `context.callId` that stays the same when that happens, so a function can pass it on as an idempotency key. A function that can't, such as one that charges a card, can be wrapped in `unsafeToRepeat()`, and an interruption during it fails the run instead:

```ts
import { unsafeToRepeat } from "@cloudflare/computer";

modules: {
  "ws:billing": {
    charge: unsafeToRepeat(async ([order, cents]) => billing.charge(order, cents)),
    refund: async ([order], { callId }) => billing.refund(order, { idempotencyKey: callId }),
  },
}
```

### Waiting for an answer

A host module function can pause a replayable run until someone answers, for example to approve an action. Like replay, this is experimental. The code being run just calls the function and gets its result, however long the answer takes:

```ts
modules: {
  "ws:github": {
    postComment: async ([issue, body], ctx) => {
      const { approved } = await ctx.interrupt({ kind: "approval", issue, body });
      if (!approved) throw new Error("The comment was rejected.");
      return github.comment(issue, body, { idempotencyKey: ctx.callId });
    },
  },
}
```

`ctx.interrupt(payload)` releases the run's isolate once the run's other calls in flight finish. The run stays running, and time spent waiting doesn't count toward its timeout. `workspace.runtime.pending()` lists the calls waiting, with their payloads, and `respond()` answers one:

```ts
for (const call of await workspace.runtime.pending()) {
  await workspace.runtime.respond(call.id, call.callId, { approved: true });
}
```

Once none of its calls are waiting, the run replays to the call and the function runs again with the same `callId`. This time `interrupt()` returns the answer straight away, and the function carries on. Anything it does before `interrupt()` runs twice, so keep that part safe to repeat. A waiting run survives a deploy like any interrupted run, and `killExec()` ends one.

- A call can interrupt once. A second `interrupt()` in the same call throws.
- Only a run with `onInterrupt: "replay"` can wait. Anywhere else, `interrupt()` throws, so a Workspace with modules that interrupt should make `"replay"` its backend's default.
- Calls that interrupt together are answered one after another. A run is released with the calls that were in flight, and a call it makes after that waits once it resumes.
- `respond()` throws `ENOTWAITING` for a call that isn't waiting, such as one already answered, so answering twice changes nothing.
- Every answer replays the run from the top.

### Limits

- A run gets three attempts, counted again each time it journals a call, and has to finish within its original timeout, counted from when it first started.
- A run only resumes on the same runtime. A new compatibility date or flags, or a new `maxStdioBytes` or `maxCapabilityBytes`, fails the runs it interrupted, and so does an upgrade of this package that changes how runs replay.
- Interrupted runs restart four at a time, since a Durable Object can only run ten Dynamic Workers at once.
- A replayable run's `fetch` is buffered rather than streamed, and each body has to fit in `maxCapabilityBytes` (1 MiB by default). Requests don't count toward `maxCapabilityCalls`, and at most six are open at once, with the rest waiting. A request in flight at the restart is sent again. Aborting a request stops the code waiting for it, but the host's request runs until it finishes.
- Keys from `crypto.subtle.generateKey()`, `node:crypto` randomness, `node:timers` and `cloudflare:sockets` aren't replayed. A run that prints their results or passes them to a call fails on replay.
- The journal uses Durable Object storage until the run settles: roughly the size of every response, plus the run's code.

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

Caller source can import four kinds of module, and all of them are fixed when the backend is constructed:

| Kind | Configured with | Runs in | Example |
| --- | --- | --- | --- |
| Built in | Always installed | The isolate, backed by the Workspace | `node:fs`, `node:fs/promises` |
| Node.js | `nodejs_compat` in `compatibilityFlags`, the default | The isolate, provided by the runtime | `node:path`, `node:crypto` |
| Source | `modules: { name: "source" }` | The isolate | a bundled library |
| Host | `modules: { "ws:name": { fn } }`, or a factory | The Durable Object | `ws:git`, `ws:container`, `ws:tools`, your own |

```ts
import { createArtifactsModule } from "@cloudflare/computer/modules/artifacts";
import { createAssetsModule } from "@cloudflare/computer/modules/assets";
import { createContainerModule } from "@cloudflare/computer/modules/container";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { createToolBindings } from "@cloudflare/computer/modules/tools";
import { forPiTools } from "@cloudflare/computer/tools/pi-ai";

new WorkerJavaScriptBackend({
  loader: env.LOADER,
  modules: {
    "tar-stream": TAR_STREAM_BUNDLE,
    "ws:git": createGitModule(),
    "ws:artifacts": createArtifactsModule(),
    "ws:assets": createAssetsModule(),
    "ws:container": createContainerModule(),
    "ws:tools": createToolBindings(forPiTools(() => agent.tools)),
    "ws:weather": {
      forecast: ([city]) => lookUpForecast(String(city)),
    },
  },
});
```

An import that is not built in, configured, one of the allowed Node.js modules, or a relative or absolute Workspace path fails before the Worker is created. Caller source and durable files cannot shadow a configured or built-in module.

The allowed Node.js modules are the ones that work entirely inside the isolate: `node:path`, `node:url`, `node:util`, `node:events`, `node:buffer`, `node:assert`, `node:string_decoder`, `node:querystring`, `node:stream`, `node:crypto`, `node:zlib`, `node:timers`, `node:async_hooks`, and `node:diagnostics_channel`, with their subpaths such as `node:path/posix` and `node:timers/promises`. The runtime provides them, and imports of them are left as written. A bare name such as `path` works too and becomes `node:path`, unless a configured module has that name, in which case the configured module wins. The runtime has more Node.js modules, but they either duplicate what the Workspace provides, as `node:fs` does, reach outside the isolate, or are stubs that throw when called, so they stay unavailable.

Any import that is not a path is resolved by name. The Worker Loader has no `node_modules` lookup and resolves a bare import next to the importing file, so Workspace stores each source and host module once, in a `__modules__` directory of the Worker's bundle, and rewrites every import of one into a relative path to it. Every file that imports `lodash` gets the same instance, however many directories the code spans. An absolute import is rewritten the same way. Relative paths are the only form the Worker Loader's legacy and new module registries resolve alike, so imports work whether or not `compatibilityFlags` includes `new_module_registry`. The Workers runtime still treats `new_module_registry` as experimental, so a Worker that adds it also needs the `experimental` compatibility flag; the default settings need neither. When a module fails to link, the error names it as the code wrote it.

The backend describes its modules for a model in `backend.description`, which `workspace.runtime.backends()` returns and the `exec` tool shows. It is built from the same `modules` option the backend runs with, so it always matches what is installed:

```text
`command` is ECMAScript module source, run in an isolated JavaScript runtime. Relative imports resolve from `cwd` in the workspace.
Put the work in `export default async function (input) { ... }` and call `node:fs` and the other modules below inside it, since the module's top level can't do I/O. To run a file you've already written, re-export it: `export { default } from "./main.js"`.
Code has no direct network access.

Modules code can import:
- `node:fs/promises` (also `node:fs`): the workspace's files. ...
- `tar-stream`: a bundled library.
- `ws:git`: The workspace's Git repository tools: `status({ dir })`, ...
- `ws:container`: Runs shell commands in a full Linux container that shares this workspace's files. ...
- `ws:weather`: exports `forecast`.
- Node.js built-ins: `node:path`, `node:url`, ... Bare names such as `path` work too.
```

A factory adds its own text through a `description` property, as the prebuilt modules do. The backend reads it each time it describes itself, not once when it is constructed, so a factory can define `description` as a getter and describe something that exists only later, as `ws:tools` does with the agent's tools. An object of functions is listed by its export names; say more about it in the `exec` tool's backend description if the model needs it.

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

Source modules live together in the module directory, not beside the caller's files. A source module may import another source module by its bare name or as `./name`, a configured host module, or a built-in module, but not a Workspace file; an import of one fails before the Worker is created and names the module. A computed dynamic import in a source module resolves by name at run time among the other source modules.

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

When the functions need the Workspace's Git client, Artifacts client, runtime, or assets client, pass a factory instead. `host.assets` is absent when the Workspace has no assets configured. The backend calls it once when it connects to its Workspace. This is how the prebuilt modules work:

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

The arguments come from caller code, so parse them before use. A function may return a value or a promise. Arguments and results cross the isolate boundary as real values through Workers RPC, not as encoded text. The result must be JSON-compatible plain data, and the bridge checks it at runtime. As in JSON, an `undefined` result or array item becomes `null` and an `undefined` object field is left out, in arguments and results alike. Byte arrays work for `node:fs` calls but not for host modules. It fits within the same capability byte limits as every other host call. A function that ignores `signal` and never settles keeps the execution in its finalizing state.

Specifiers and the export names of an object are checked at construction. A factory's export names are checked when the backend connects and the factory runs. An object must export at least one function. A factory may build none, as `ws:tools` does for an agent with no tools: the backend then leaves that module out of the connection, so only code that imports it fails, with a message saying the module exports nothing, and every other run still starts. Every export name must be a JavaScript identifier name other than `default` or `then`. A reserved word such as `delete` is allowed, and caller code renames it on import: `import { delete as remove } from "ws:files"`. Importing a name the module does not export fails when the module graph links, before any code runs.

### `ws:git`

```js
import { clone, diff, status, log, cli } from "ws:git";
```

`createGitModule()` from `@cloudflare/computer/modules/git` wraps the Workspace's Git client. Every `dir` and `cwd` is confined to the backend root, `clone` and `cli` need a read-write backend, and `cli` treats a leading `-C <path>` as its working directory, confined the same way, while rejecting any other `-C`, `--git-dir`, and `--work-tree`. Clone, fetch, pull, push, `ls-remote`, and submodule commands run from the host, even when the Dynamic Worker has `globalOutbound: null`, so they are denied unless you pass `createGitModule({ allowNetwork: true })`.

### `ws:artifacts`

```js
import { create, get, list, importArtifact, deleteArtifact, createToken, share } from "ws:artifacts";
```

`createArtifactsModule()` from `@cloudflare/computer/modules/artifacts` wraps the Workspace's Artifacts client. Calls that change Artifacts need a read-write backend. `importArtifact()` fetches from a caller-chosen URL on the host, so it is denied unless you pass `createArtifactsModule({ allowNetwork: true })`. Every call fails clearly when no Artifacts binding is configured.

Two functions mint the git token that cloning or pushing a repository needs:

- `createToken(name, scope?, ttl?)` returns `{ id, plaintext, scope, expiresAt }`.
- `share(name, { scope?, ttl? })` returns the repository's remote URL with a token embedded, the same URL `artifacts share` prints. It resolves the repository first, so a missing one fails without minting a token.

`scope` is `"read"` (the default) or `"write"`, and a write token needs a read-write backend. `ttl` is seconds, or a duration such as `"15m"` or `"2h30m"`; without it the binding's default applies. The URL from `share` is a credential: pass it to `ws:container` through `env` rather than in the command text, and do not return it from the run.

```js
import { share } from "ws:artifacts";
import { exec } from "ws:container";

export default async function () {
  const url = await share("site", { scope: "write", ttl: "30m" });
  const push = await exec('git push "$REMOTE" HEAD:main', { cwd: "/workspace/site", env: { REMOTE: url } });
  return { pushed: push.exitCode === 0 };
}
```

### `ws:assets`

```js
import { publish } from "ws:assets";
```

`createAssetsModule()` from `@cloudflare/computer/modules/assets` publishes a Workspace file through the Workspace's assets client (see [14. Assets interface](./14_assets_interface.md)) and returns a time-limited URL:

```js
import { publish } from "ws:assets";

export default async function () {
  return publish("/workspace/out/report.pdf", { expiresAfter: "1d", disposition: "attachment" });
}
```

`publish(path, { expiresAfter?, filename?, disposition?, contentType? })` resolves `path` against the backend root like any other host call. `expiresAfter` is milliseconds or a duration such as `"30m"`; the default is one hour, `createAssetsModule({ defaultExpiresAfterMs })` changes it, and the assets client caps it at seven days. `disposition` is `"inline"` or `"attachment"`. If the Workspace has no assets client, the JavaScript backend fails to connect. Publishing uploads a file and hands out a public link, so `publish` refuses to run on a read-only backend, as the read-only tool set has no `publish` tool.

### `ws:tools`

`createToolBindings()` from `@cloudflare/computer/modules/tools` exports the agent's own tools to JavaScript, each under its own name. A loop over a hundred files is then one `exec` call instead of a hundred model turns:

```js
import { grep, read } from "ws:tools";

export default async function ({ files }) {
  const todos = {};
  for (const path of files) {
    const { text, isError } = await grep({ query: "TODO", path });
    if (!isError && text.trim()) todos[path] = text;
  }
  return todos;
}
```

Each export takes one object of the tool's arguments, the same object the model would pass, and resolves with `{ text, details, isError }`, plus `structuredContent` when the tool returns it. A tool that throws rejects the call. `exec` is left out by default, since the code is already running inside `exec` and a run that can start runs has no bound on how deep it goes. Pass `exclude` to change the list.

What a tool is and how it runs belongs to the agent library, so `createToolBindings()` takes bindings: a name, and a function to call with the input and the call's context. `forPiTools()` from `@cloudflare/computer/tools/pi-ai` builds them from pi tools:

```ts
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createToolBindings } from "@cloudflare/computer/modules/tools";
import { forPiTools } from "@cloudflare/computer/tools/pi-ai";

new WorkerJavaScriptBackend({
  loader: env.LOADER,
  modules: {
    "ws:tools": createToolBindings(forPiTools(() => agent.tools, { validate: validateToolArguments })),
  },
});
```

`forPiTools()` takes executable tools in the shape `@earendil-works/pi-agent-core` defines, or the result of `createPiTools()`. It runs a call the way pi's agent loop runs a model's call: `prepareArguments`, then `validate`, then `execute` with a fresh call id and the call's abort signal. Pass pi-ai's `validateToolArguments` as `validate` to hold code to the same check as the model; without it, arguments reach the tool unchecked. Text parts of the result are joined, and an image is named in place, as `[image: image/png]`.

`forAISDKTools()` from `@cloudflare/computer/tools/ai-sdk` builds them from an AI SDK tool set:

```ts
import { createToolBindings } from "@cloudflare/computer/modules/tools";
import { forAISDKTools } from "@cloudflare/computer/tools/ai-sdk";

"ws:tools": createToolBindings(forAISDKTools(() => agentTools))
```

It checks the code's arguments against the tool's `inputSchema`, as the AI SDK checks a model's call, and calls `execute` with the parsed value, a fresh call id, and the call's abort signal. Arguments that fail the check reject the call, and a schema's defaults apply. A string result becomes the text; anything else is the JSON text, and `details` holds the value. A result shaped `{ error: string }`, which is how this package's tools report a failure such as a missing file, comes back with `isError: true` and the message as the text. A streaming tool resolves with its last value. Tools with no `execute` function, which run in the browser, and tools that set `needsApproval` are left out, because nothing can approve or run them from code. With a function of tools, a call runs the tool the function returns at that moment, so an agent can swap its tool set between turns without the module going stale.

Pass a function of tools, rather than a list, when the tools need something that does not exist yet when the backend is constructed, such as the Workspace they act on. The function runs each time the backend connects. A tool whose name cannot be a JavaScript export is exported under a normalized name: `-`, `.`, and spaces become `_`, other characters an identifier cannot hold are dropped, a leading digit gets a `_` in front, and `default`, `then`, and `__proto__` get one behind, so `list-files` becomes `list_files`. Two tools that normalize to the same name fail the connection.

On a backend with `access: "read"`, only tools marked `readOnly` run. Every other call is refused before the tool runs, as `ws:git` and `ws:container` refuse to write there. `createToolBindings()` cannot tell what a tool does, so an unmarked tool is taken to write. `forPiTools()` marks `read`, `ls`, `find`, and `grep` from `createPiTools()`. For your own pi tools, name the ones that only read: `forPiTools(tools, { readOnly: ["read", "grep"] })`.

The module's description lists the names code can import. With a function of tools, the function is called again each time the backend describes itself, so the `exec` tool, built after the Workspace, sees the current list. A list is read as given; any other iterable may be single-use, so it is not read for the description, and neither is a function that throws.

### `ws:container`

`createContainerModule()` from `@cloudflare/computer/modules/container` lets JavaScript run shell commands in the Workspace's container backend. With it, JavaScript is the only backend the model sees, and the container is something that JavaScript can call:

```ts
import { ContainerBackend, withWorkspaceContainer } from "@cloudflare/computer/backends/container";

class Agent extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [
      new WorkerJavaScriptBackend({
        loader: this.env.LOADER,
        access: "read-write",
        modules: { "ws:container": createContainerModule() },
      }),
      new ContainerBackend({
        container: () => this,
        workspace: { binding: "Agent", id: this.ctx.id.toString() },
        egress: { mode: "direct" },
      }),
    ],
  });
}

// Offer only the JavaScript backend; the container is reached through ws:container.
const tools = createAITools({ workspace: this.workspace, exec: { "worker-javascript": {} } });
```

```js
import { exec } from "ws:container";

export default async function () {
  const { exitCode, stdout, stderr } = await exec("npm test", { cwd: "/workspace/app" });
  return { passed: exitCode === 0, stdout, stderr };
}
```

`exec(command, { cwd, env, stdin, timeoutMs })` runs through `workspace.runtime.exec` on the container backend: `ContainerBackend`, registered as `"container-shell"` unless you pass `backend`. If that backend is missing, or runs module source rather than shell commands, the JavaScript backend fails to connect. The container shares the Workspace's files: writes the module made before the call are pushed to the container, and the container's changes are pulled back before `exec` returns. A non-zero exit code comes back as a value, not as an error.

The result also carries `sync`: `{ status, skipped, skippedCount, error? }`. `status` is `pending` when the container's file changes have not reached the Workspace yet, and `error` says why. `skipped` lists up to 100 paths the container wrote that the Workspace refused, such as files in a read-only mount, and `skippedCount` gives the full count. The sync is last-writer-wins: the container's changes replace files written in the Workspace while the command runs, without reporting them as skipped. Don't write files from the isolate that the running command also writes.

A few limits follow from `exec` being a host call:

- Output comes back when the command finishes, not while it runs. Each stream keeps its last 2000 lines or `maxOutputBytes` (64 KiB by default), which must stay well under the backend's `maxCapabilityBytes`. When a stream is cut, the result's `truncated.stdout.path` (or `stderr`) names a Workspace file holding all of it (see [Long output](./05_runtime_interface.md#long-output)), and the host never holds more than the end in memory. The default directory, `/.computer/output`, is outside the backend's default `root` (`/workspace`), so isolate code cannot open it with `node:fs`; the agent's `read` and `grep` tools can. Set the Workspace's `output.dir` under `root` if isolate code needs to read it. A Workspace with `output: false` saves nothing and leaves output whole, so the module cuts each stream to the same limits itself and starts it with a note such as `[truncated, showing lines 2001-4000 of 4000]` in place of `truncated`.
- The command's timeout is capped at the time left before the host call deadline (`maxHostCallMs`, which defaults to `maxTimeoutMs`). Raise `defaultTimeoutMs`, `maxTimeoutMs`, and `maxHostCallMs` for slow installs and builds, and remember the container's first start.
- Cancelling the execution kills the running command.

A container command can write to the Workspace, so `exec` refuses to run on a read-only backend. Whether it can reach the network follows `ContainerBackend`'s own `egress` setting, not the JavaScript backend's.

Two options shape every command:

| Option | Default | Notes |
| --- | --- | --- |
| `prelude` | none | Shell text run before each command, joined to it by a newline, such as `set -o pipefail` or `export` lines. A newline keeps a command that opens with a comment or a shebang intact, and does not skip the command when the prelude's last status is non-zero. |
| `maxOutputLines` | the runtime's 2000 | The most lines of each stream the result keeps, alongside `maxOutputBytes`. |

```ts
createContainerModule({
  prelude: ["set -o pipefail", 'export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Agent}"'].join("\n"),
  maxOutputLines: 200,
});
```

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
