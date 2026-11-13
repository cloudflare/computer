# Isolate JavaScript runtime

> [!NOTE]
> **Stable.** `CodemodeBackend` and its host modules are
> suitable for production use, except `codemode:container`, which runs on the
> experimental container backend. See the [status table](../packages/computer/README.md#status).

`CodemodeBackend` runs an ECMAScript module in a fresh Cloudflare Dynamic Worker:

```ts
import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";

const workspace = new Workspace({
  storage: ctx.storage,
  backends: [
    new CodemodeBackend({
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

The backend registers as `"codemode"` unless you pass `id`. Execute a module through the common runtime entry point:

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
    backend: "codemode",
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
    backend: "codemode",
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
new CodemodeBackend({
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
const backend = new CodemodeBackend({ loader: env.LOADER, onInterrupt: "replay" });

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
  "codemode:billing": {
    charge: unsafeToRepeat(async ([order, cents]) => billing.charge(order, cents)),
    refund: async ([order], { callId }) => billing.refund(order, { idempotencyKey: callId }),
  },
}
```

### Waiting for an answer

A host module function can pause a replayable run until someone answers, for example to approve an action. Like replay, this is experimental. The code being run just calls the function and gets its result, however long the answer takes:

```ts
modules: {
  "codemode:github": {
    postComment: async ([issue, body], ctx) => {
      const { approved } = await ctx.interrupt({ kind: "approval", issue, body });
      if (!approved) throw new Error("The comment was rejected.");
      return github.comment(issue, body, { idempotencyKey: ctx.callId });
    },
  },
}
```

`ctx.interrupt(payload)` releases the run's isolate once the run's other calls in flight finish. The run stays running, and time spent waiting doesn't count toward its timeout. `workspace.runtime.pending()` lists the calls waiting, with their payloads and their run's `metadata`, and `respond()` answers one:

```ts
for (const call of await workspace.runtime.pending()) {
  await workspace.runtime.respond(call.id, call.callId, { approved: true });
}
```

To hear about a wait when it starts, for example to message whoever answers, give the backend an `onWait` function. It gets the same fields, at most once per wait, so `pending()` stays the source of truth. A Worker that calls the object can reach `pending()` and `respond()` through `workspace.stub().runtime`.

Once none of its calls are waiting, the run replays to the call and the function runs again with the same `callId`. This time `interrupt()` returns the answer straight away, and the function carries on. Anything it does before `interrupt()` runs twice, so keep that part safe to repeat. A waiting run survives a deploy like any interrupted run, and `killExec()` ends one.

- A call can interrupt once. A second `interrupt()` in the same call throws.
- Only a run with `onInterrupt: "replay"` can wait. Anywhere else, `interrupt()` throws, so a Workspace with modules that interrupt should make `"replay"` its backend's default.
- A run is released once each call in flight has finished or is waiting too, and those waits are answered together. A call the run makes after the first interrupt is held until it resumes, so a call that interrupts straight away can leave the next one to wait for a later round.
- `respond()` throws `ENOTWAITING` for a call that isn't waiting, such as one already answered, so answering twice changes nothing.
- Every answer replays the run from the top.

### Detaching a run that waits

Whoever started a run can await its result, but a run that waits for a person can outlive them: an agent's tool call may want to move on, or a deploy may end the request that started it. Give `CodemodeBackend` an `onDetachedExit` and its runs can detach, so `onDetachedExit` hears how they end instead, even across deploys: see [Detaching](./05_runtime_interface.md#detaching). The `exec` tool detaches a run once it waits, when it's built with `detach`: see [Detaching](./09_tool_interface.md#detaching).

### Limits

- A run gets three attempts, counted again each time it journals a call, and has to finish within its original timeout, counted from when it first started.
- A run only resumes on the same runtime. A new compatibility date or flags, or a new `maxStdioBytes` or `maxCapabilityBytes`, fails the runs it interrupted, and so does an upgrade of this package that changes how runs replay.
- Interrupted runs restart four at a time, since a Durable Object can only run ten Dynamic Workers at once.
- A replayable run's `fetch` is buffered rather than streamed, and each body has to fit in `maxCapabilityBytes` (1 MiB by default). Requests don't count toward `maxCapabilityCalls`, and at most six are open at once, with the rest waiting. A request in flight at the restart is sent again. Aborting a request stops the code waiting for it, but the host's request runs until it finishes.
- Keys from `crypto.subtle.generateKey()`, `node:crypto` randomness, `node:timers` and `cloudflare:sockets` aren't replayed. A run that prints their results or passes them to a call fails on replay.
- The journal uses Durable Object storage until the run settles: roughly the size of every response, plus the run's code.

## Environment, standard input, and the `process` shim

Each execution installs a small `node:process` shim so ordinary module code can read its environment and standard streams. The shim exposes only what the caller supplies for that execution; the host environment is never visible.

`process.env` is a snapshot of the `env` record passed on the exec options. Values the caller does not pass are absent, and the Durable Object's own environment is never merged in, so a module cannot read host bindings or secrets through `process.env`. The exec option `metadata` is for host modules and never appears here.

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
    backend: "codemode",
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
| Host | `modules: { "codemode:name": { fn } }`, a factory, or `createCodemodeModule()` | The Durable Object | `codemode:git`, `codemode:container`, `codemode:tools`, `codemode:browser`, your own |

```ts
import { createArtifactsModule } from "@cloudflare/computer/modules/artifacts";
import { createAssetsModule } from "@cloudflare/computer/modules/assets";
import { createContainerModule } from "@cloudflare/computer/modules/container";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { createToolBindings } from "@cloudflare/computer/modules/tools";
import { forPiTools } from "@cloudflare/computer/tools/pi-ai";

new CodemodeBackend({
  loader: env.LOADER,
  modules: {
    "tar-stream": TAR_STREAM_BUNDLE,
    "codemode:git": createGitModule(),
    "codemode:artifacts": createArtifactsModule(),
    "codemode:assets": createAssetsModule(),
    "codemode:container": createContainerModule(),
    "codemode:tools": createToolBindings(forPiTools(() => agent.tools)),
    "codemode:weather": {
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
- `codemode:git`: The workspace's Git repository tools: `status({ dir })`, ...
- `codemode:container`: Runs shell commands in a full Linux container that shares this workspace's files. ...
- `codemode:weather`: exports `forecast`.
- Node.js built-ins: `node:path`, `node:url`, ... Bare names such as `path` work too.
```

A factory adds its own text through a `description` property, as the prebuilt modules do. The backend reads it each time it describes itself, not once when it is constructed, so a factory can define `description` as a getter and describe something that exists only later, as `codemode:tools` does with the agent's tools. A codemode module takes `description` as an option. An object of functions, or a codemode module without a description, is listed by its export names; say more about it in the `exec` tool's backend description if the model needs it.

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

A string value is JavaScript source installed as a bare import, such as a bundled library. It is plain code with no host access, and it cannot replace `node:fs` or `node:fs/promises`.

Source can also be a library the host provides, under a simple `codemode:*` specifier like a host module's. Host modules export only functions, so a host that wants to offer objects, or anything else that isn't a function, wraps its host modules in a source module of its own. The model is told it's a library the host provides:

```ts
modules: {
  "codemode:weather-host": { forecast: ([city]) => lookUpForecast(String(city)) },
  "codemode:weather": `
    import { forecast } from "codemode:weather-host";
    export const weather = { forecast: (city) => forecast(city) };
  `,
}
```

Source modules live together in the module directory, not beside the caller's files. A source module may import another source module by its bare name (or its `codemode:*` name) or as `./name`, a configured host module, or a built-in module, but not a Workspace file; an import of one fails before the Worker is created and names the module. A computed dynamic import in a source module resolves by name at run time among the other source modules.

### Host modules

A host module runs in the Durable Object, and each of its functions becomes a named export in the isolate. Host modules must use a simple `codemode:*` specifier, or one under the backend's [module scheme](#module-scheme). Nothing under `codemode:` is installed unless you configure it.

Pass an object of functions:

```ts
modules: {
  "codemode:weather": {
    forecast: ([city]) => lookUpForecast(String(city)),
  },
}
```

When the functions need the Workspace's Git client, Artifacts client, runtime, or assets client, pass a factory instead. `host.assets` is absent when the Workspace has no assets configured. The backend calls it once when it connects to its Workspace. This is how the prebuilt modules work:

```ts
modules: {
  "codemode:repo": (host) => ({
    async recent(args, context) {
      const dir = await context.resolvePath(String(args[0] ?? "."));
      return host.git.log({ dir, depth: 5 });
    },
  }),
}
```

```js
import { recent } from "codemode:repo";
export default () => recent("/workspace/app");
```

Each function receives the arguments the isolate passed, as an array of JSON-compatible values, and a context:

| Field | Meaning |
| --- | --- |
| `signal` | Aborts when the call passes its deadline or the execution is cancelled. |
| `deadline` | Epoch milliseconds after which the isolate stops waiting. |
| `access` | The backend's `"read"` or `"read-write"` access. Check it before any write. |
| `resolvePath(path, { allowMissing })` | Confines a caller path to the backend root and rejects symlinks. |
| `execution` | The run the call belongs to: `{ id, metadata }`. Every call of one run gets the same values, and a replayable run keeps them when it resumes. Ids are unique within one backend, and a module's functions are per backend connection, so the id alone tells the module's runs apart. |

The arguments come from caller code, so parse them before use. A function may return a value or a promise. Arguments and results cross the isolate boundary as real values through Workers RPC, not as encoded text. The result must be JSON-compatible plain data, and the bridge checks it at runtime. As in JSON, an `undefined` result or array item becomes `null` and an `undefined` object field is left out, in arguments and results alike. Byte arrays work for `node:fs` calls but not for host modules. It fits within the same capability byte limits as every other host call. A function that ignores `signal` and never settles keeps the execution in its finalizing state.

`metadata` is whatever the app passed to `exec()`, or an empty object. It's a record of strings that tells host modules who a run is for, such as the conversation that started it:

```ts
await workspace.runtime.exec(source, {
  backend: "codemode",
  metadata: { conversation: conversationId },
});

modules: {
  "codemode:notes": {
    add: ([text], { execution }) => {
      const { conversation } = execution.metadata;
      if (conversation === undefined) throw new Error("This run isn't for a conversation.");
      return notes.add(conversation, String(text));
    },
  },
}
```

Host code reads metadata as `WorkspaceExecutionMetadata`, whose values may be `undefined`, because any key may be missing: a run may have been started without metadata or by other code, and a run saved before metadata existed resumes with an empty object.

The run's code never sees metadata: it isn't in `process.env` or the input, so code can't read or change it, and a module can trust it. It's capped at 16 KiB of keys and values. A replayable run keeps its metadata when it resumes, `pending()` lists it with each waiting call, and `workspace.stub().runtime.exec()` takes it too. Backends that run no host modules ignore it.

Specifiers and the export names of an object are checked at construction. A factory's export names are checked when the backend connects and the factory runs. An object must export at least one function. A factory may build none, as `codemode:tools` does for an agent with no tools: the backend then leaves that module out of the connection, so only code that imports it fails, with a message saying the module exports nothing, and every other run still starts. Every export name must be a JavaScript identifier name other than `default` or `then`. A reserved word such as `delete` is allowed, and caller code renames it on import: `import { delete as remove } from "codemode:files"`. Importing a name the module does not export fails when the module graph links, before any code runs.

#### Module scheme

A host that wants its modules under a name of its own sets `scheme`, which replaces `codemode` in every specifier above. With `scheme: "agent"`, host modules and the libraries the host provides are `agent:git`, `agent:weather` and so on: code imports them by those names, the backend's description lists them so, and an import of an `agent:*` module that isn't configured fails before the Worker is created, as an unconfigured `codemode:*` one does by default.

```ts
new CodemodeBackend({
  loader: env.LOADER,
  scheme: "agent",
  modules: {
    "agent:git": createGitModule(),
    "agent:web": createBrowserModule({
      browser: this.browser,
      specifier: "agent:web",
      toolsSpecifier: "agent:tools",
    }),
    "agent:tools": createToolBindings(forPiTools(() => agent.tools)),
  },
});
```

`codemode:*` is then an ordinary bare name: a host module can't use it, and code that imports one it doesn't have fails as it would for any other unknown module. A backend has one scheme. It must be a lowercase letter followed by lowercase letters, digits, or `-`, and can't be one the Workers runtime or URLs already give a meaning, such as `node`, `cloudflare`, `http`, or `file`. The default, `codemode`, behaves exactly as before.

The prebuilt modules work under any specifier. `createBrowserModule()` tells the model which specifier to import it from, and not to reach the browser tool through `codemode:tools`, so pass it `specifier` and `toolsSpecifier` when it's served under other names.

#### Codemode modules

`createCodemodeModule()` builds a host module that can return objects with methods, and give its functions shared context. Define the kinds of object the module returns, add context, then make the module:

```ts
import { createCodemodeModule } from "@cloudflare/computer";

const jobs = createCodemodeModule({ description: "Build jobs: `createJob(name)` returns a job." });

jobs.context("api", (host) => createJobsClient(host));

const Run = jobs.define("Run", ({ id }) => ({
  wait: async (_args, ctx) => ctx.api.wait(id, { signal: ctx.signal }),
}));

const Job = jobs.define("Job", ({ id }) => ({
  start: async ([ref], ctx) => Run({ id: await ctx.api.start(id, ref, { key: ctx.callId }) }),
}));

modules: {
  "codemode:jobs": jobs.module({
    createJob: async ([name], ctx) => Job({ id: await ctx.api.create(name, { key: ctx.callId }) }),
  }),
}
```

```js
import { createJob } from "codemode:jobs";
const job = await createJob("build");
const run = await job.start("main");
await approval();                // the run can wait here, across a deploy
const { status } = await run.wait();
```

`define(kind, build)` returns a constructor. Calling `Run({ id })` builds the object and remembers its kind and its state. The state can hold anything a replayable run carries, listed below, and must be enough to build the object again: after a pause or a restart, the backend calls the same builder with the saved state. So an object is whatever its state rebuilds. Kind names are strings, stored with the module's specifier, such as `codemode:jobs#Run`, so don't use a class or variable name a minifier could change.

Each method is called as `(args, ctx)`, like an exported function, with its own context: `callId`, `signal`, `deadline`, `access` and `interrupt()`. A method call is a host call like any other, so it counts toward the limits, is journaled, and replays. In program code an object is a proxy whose methods make those calls. Awaiting, logging or serializing it doesn't call the host. Its `Symbol.dispose` and `Symbol.asyncDispose` release it: the host object's own `Symbol.asyncDispose` (or `Symbol.dispose`) runs with reason `"disposed"`, and the proxy refuses calls after that. A ref the run wasn't given is refused.

##### Fields, promises and streams

An object can have members that aren't methods. Each is made with a helper, and code reads it as a property. These work the same way in every run, including replayable ones:

```ts
import { createCodemodeModule, field, promised, readable, writable } from "@cloudflare/computer";

const Proc = procs.define("Proc", ({ id, pid }) => ({
  pid: field(pid),                                 // a value: proc.pid
  exitCode: promised(() => running(id).exitCode),  // a promise: await proc.exitCode
  stdout: readable(() => running(id).stdout),      // a ReadableStream of bytes
  stdin: writable(() => running(id).stdin),        // a WritableStream of bytes
  kill: async ([signal]) => running(id).kill(signal),
}));
```

- **`field(value)`** travels with the object, so reading it makes no host call. Its value must be something a result could hold, and can't be another object.
- **`promised(settle)`** runs `settle` on the host the first time code reads the property. The backend then waits for it across as many host calls as it takes: a call about to reach its deadline answers "not yet", and the isolate calls again. So a promise that settles after `maxHostCallMs` still arrives, and code just awaits it.
- **`readable(open)`** opens the host stream on the first read. Its chunks travel as host calls made only as code reads, so backpressure reaches the host stream. A chunk larger than one call can carry arrives in pieces.
- **`writable(open)`** opens the host stream on the first write. A write is accepted once the host stream has room, and closing or aborting reaches the host stream. A write's failure shows on the next write or the close.

`settle` and `open` get a context whose `signal` aborts when the scope ends, since a promise or stream outlives the call that first asked for it. Member names must be JavaScript identifiers.

In a replayable run, every one of these calls is journaled. A replay answers them again without running `settle` or `open`, so chunks read before a pause or a restart come back exactly as they were. A run that carries on live afterwards rebuilds the object from its state, and its first live member call runs `settle` or `open` again. For a process that died with the scope, that's where the error shows.

Stream calls don't count against `maxCapabilityCalls` or the capability byte budgets, which a command's output would use up on its own. Each call is still bounded by `maxCapabilityBytes` and by the concurrency limit. In a replayable run, the bytes they journal, in and out together, count against `maxStreamBytes` (64 MiB by default). A run that doesn't replay journals nothing, so its streams are bounded only per call.

`context(name, create)` adds `ctx[name]` to every function and method in the module. Without options it's made once, when the backend connects, from the services a factory gets. With `{ scoped: true }` it's made once for each scope of a run, from `({ id, metadata, signal }, host)`, the first time a method reads it, and `ctx[name]` is then a promise of the value:

```ts
const browser = createCodemodeModule();
browser.context(
  "session",
  (scope) => browsers.connect({ conversation: scope.metadata.conversation }),
  {
    scoped: true,
    async dispose(session, end) {
      await session.close();
      if (end.reason !== "paused") end.log("Closed the browser.\n");
    },
  },
);
const Page = browser.define("Page", ({ pageId }) => ({
  text: async (_args, ctx) => (await ctx.session).page(pageId).text(),
}));
modules: {
  "codemode:browser": browser.module({
    open: async ([url], ctx) => Page({ pageId: await (await ctx.session).open(String(url)) }),
  }),
}
```

A scope lasts from when the run's code starts in an isolate until it waits in `ctx.interrupt()` or ends. A run that resumes starts again from the top in a new scope. Reads made while a scoped context starts share that start, and a call answered from the journal never runs its method, so it never starts one. Objects read context when they're called, not when they're built, so rebuilding an object never depends on it.

When a scope ends, every scoped context that started, and every live object with a disposer, is disposed. A context uses its `dispose` option, or else its value's own `Symbol.asyncDispose` or `Symbol.dispose`. Disposers get one of these reasons:

- `"paused"`: the run is waiting in `ctx.interrupt()` and has released its isolate. An answer that arrives meanwhile resumes the run once disposal is done.
- `"completed"`, `"failed"`, or `"cancelled"`: the run ended. Disposal runs before its exit is published, and only these reasons have `log(text)`, which appends text to the run's stderr ahead of its exit. Logged text is saved with the run's terminal state. Text past what's left of the run's `maxStdioBytes` is cut, and ends with a line saying `Host module output truncated.` Text logged after the disposer returns is dropped.
- `"disposed"`: program code released the object early.

A run killed while it waits has nothing open, so nothing is disposed. If the Durable Object restarts during a scope, what the scope held goes with it, undisposed. Everything closes at once, with a `signal` and a `deadline`, and the backend waits up to `maxHostCallMs`. A disposer that throws or runs late is reported with `console.error`, and the run goes on.

In a run that doesn't replay, a codemode module can also take callbacks, and return streams and live RPC stubs, which Workers RPC carries as they are. A callback lasts for the call it was passed to. A replayable run refuses them, since the journal can't keep them, with one exception: a `ReadableStream` passed as an argument, anywhere in plain data. The isolate sends its chunks in journaled calls of their own, each once the host has room, and the function gets an ordinary `ReadableStream`. If the function returns without starting to read it, the stream is cancelled, and the isolate stops sending. Return a stream from a replayable run with `readable()`.

An `AbortSignal` can be passed to a codemode module in any run, anywhere in plain data, although Workers RPC can't carry one. The isolate sends its abort as a call of its own, journaled in a replayable run, and the function gets an ordinary `AbortSignal` that aborts with an `AbortError` carrying the reason's message. A signal that was already aborted arrives aborted.

In a replayable run, arguments, results and object state can be JSON plus `Date`, `bigint`, byte arrays, `ArrayBuffer` and other typed arrays, `Headers`, `NaN` and `Infinity`, and errors. The journal stores them with [Cap'n Web](https://github.com/cloudflare/capnweb)'s encoding, and plain JSON keeps the format older journals use. In results, `undefined` follows JSON's rules in every run: an `undefined` field is left out, and an `undefined` array item or result becomes `null`. `URL`, `Map`, `Set` and `RegExp` can't be used there: Workers RPC can't carry a `URL`, and Cap'n Web can't encode the others yet. A thrown error keeps its standard name, such as `RangeError`, and its own properties, live and on replay. A builder makes one module, unless it has a `name`. Codemode modules are experimental and may change in any release.

### `codemode:git`

```js
import { clone, fetch, pull, push, diff, status, log, cli } from "codemode:git";
```

`createGitModule()` from `@cloudflare/computer/modules/git` wraps the Workspace's Git client. Every `dir` and `cwd` is confined to the backend root, `clone`, `fetch`, `pull`, `push` and `cli` need a read-write backend, and `cli` treats a leading `-C <path>` as its working directory, confined the same way, while rejecting any other `-C`, `--git-dir`, and `--work-tree`. Clone, fetch, pull, push, `ls-remote`, and submodule commands run from the host, even when the Dynamic Worker has `globalOutbound: null`, so they are denied unless you pass `createGitModule({ allowNetwork: true })`.

`clone`, `fetch`, `pull` and `push` take the same options as the matching `GitClient` methods, and `push` is marked unsafe to repeat. They and `cli` take `headers`, sent with every request to the remote, so a token can go in an `Authorization` header instead of the remote URL, where it would be saved in `.git/config`:

```js
import { createToken, get } from "codemode:artifacts";
import { clone, push } from "codemode:git";

export default async function () {
  const { remote } = await get("site");
  const { plaintext } = await createToken("site", "write", "15m");
  const headers = { Authorization: `Bearer ${plaintext}` };
  await clone({ url: remote, dir: "site", headers });
  // ...change and commit files...
  return push({ dir: "site", ref: "main", headers });
}
```

The token still passes through the isolate's code. To keep it out entirely, give `createGitClient()` a host `fetch` that adds credentials instead; see [Host Fetch and authentication](13_git_interface.md#host-fetch-and-authentication).

### `codemode:artifacts`

```js
import { create, get, list, importArtifact, deleteArtifact, createToken, share } from "codemode:artifacts";
```

`createArtifactsModule()` from `@cloudflare/computer/modules/artifacts` wraps the Workspace's Artifacts client. Calls that change Artifacts need a read-write backend. `importArtifact()` fetches from a caller-chosen URL on the host, so it is denied unless you pass `createArtifactsModule({ allowNetwork: true })`. Every call fails clearly when no Artifacts binding is configured.

Two functions mint the git token that cloning or pushing a repository needs:

- `createToken(name, scope?, ttl?)` returns `{ id, plaintext, scope, expiresAt }`.
- `share(name, { scope?, ttl? })` returns the repository's remote URL with a token embedded, the same URL `artifacts share` prints. It resolves the repository first, so a missing one fails without minting a token.

`scope` is `"read"` (the default) or `"write"`, and a write token needs a read-write backend. `ttl` is seconds, or a duration such as `"15m"` or `"2h30m"`; without it the binding's default applies. The URL from `share` is a credential: pass it to `codemode:container` through `env` rather than in the command text, and do not return it from the run.

```js
import { share } from "codemode:artifacts";
import { exec } from "codemode:container";

export default async function () {
  const url = await share("site", { scope: "write", ttl: "30m" });
  const push = await exec('git push "$REMOTE" HEAD:main', { cwd: "/workspace/site", env: { REMOTE: url } });
  return { pushed: push.exitCode === 0 };
}
```

### `codemode:assets`

```js
import { publish } from "codemode:assets";
```

`createAssetsModule()` from `@cloudflare/computer/modules/assets` publishes a Workspace file through the Workspace's assets client (see [14. Assets interface](./14_assets_interface.md)) and returns a time-limited URL:

```js
import { publish } from "codemode:assets";

export default async function () {
  return publish("/workspace/out/report.pdf", { expiresAfter: "1d", disposition: "attachment" });
}
```

`publish(path, { expiresAfter?, filename?, disposition?, contentType? })` resolves `path` against the backend root like any other host call. `expiresAfter` is milliseconds or a duration such as `"30m"`; the default is one hour, `createAssetsModule({ defaultExpiresAfterMs })` changes it, and the assets client caps it at seven days. `disposition` is `"inline"` or `"attachment"`. If the Workspace has no assets client, the codemode backend fails to connect. Publishing uploads a file and hands out a public link, so `publish` refuses to run on a read-only backend, as the read-only tool set has no `publish` tool.

### `codemode:tools`

`createToolBindings()` from `@cloudflare/computer/modules/tools` exports the agent's own tools to JavaScript, each under its own name. A loop over a hundred files is then one `exec` call instead of a hundred model turns:

```js
import { grep, read } from "codemode:tools";

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

new CodemodeBackend({
  loader: env.LOADER,
  modules: {
    "codemode:tools": createToolBindings(forPiTools(() => agent.tools, { validate: validateToolArguments })),
  },
});
```

`forPiTools()` takes executable tools in the shape `@earendil-works/pi-agent-core` defines, or the result of `createPiTools()`. It runs a call the way pi's agent loop runs a model's call: `prepareArguments`, then `validate`, then `execute` with a fresh call id and the call's abort signal. Pass pi-ai's `validateToolArguments` as `validate` to hold code to the same check as the model; without it, arguments reach the tool unchecked. Text parts of the result are joined, and an image is named in place, as `[image: image/png]`.

`forAISDKTools()` from `@cloudflare/computer/tools/ai-sdk` builds them from an AI SDK tool set:

```ts
import { createToolBindings } from "@cloudflare/computer/modules/tools";
import { forAISDKTools } from "@cloudflare/computer/tools/ai-sdk";

"codemode:tools": createToolBindings(forAISDKTools(() => agentTools))
```

It checks the code's arguments against the tool's `inputSchema`, as the AI SDK checks a model's call, and calls `execute` with the parsed value, a fresh call id, and the call's abort signal. Arguments that fail the check reject the call, and a schema's defaults apply. A string result becomes the text; anything else is the JSON text, and `details` holds the value. A result shaped `{ error: string }`, which is how this package's tools report a failure such as a missing file, comes back with `isError: true` and the message as the text. A streaming tool resolves with its last value. Tools with no `execute` function, which run in the browser, and tools that set `needsApproval` are left out, because nothing can approve or run them from code. With a function of tools, a call runs the tool the function returns at that moment, so an agent can swap its tool set between turns without the module going stale.

Pass a function of tools, rather than a list, when the tools need something that does not exist yet when the backend is constructed, such as the Workspace they act on. The function runs each time the backend connects. A tool whose name cannot be a JavaScript export is exported under a normalized name: `-`, `.`, and spaces become `_`, other characters an identifier cannot hold are dropped, a leading digit gets a `_` in front, and `default`, `then`, and `__proto__` get one behind, so `list-files` becomes `list_files`. Two tools that normalize to the same name fail the connection.

On a backend with `access: "read"`, only tools marked `readOnly` run. Every other call is refused before the tool runs, as `codemode:git` and `codemode:container` refuse to write there. `createToolBindings()` cannot tell what a tool does, so an unmarked tool is taken to write. `forPiTools()` marks `read`, `ls`, `find`, and `grep` from `createPiTools()`. For your own pi tools, name the ones that only read: `forPiTools(tools, { readOnly: ["read", "grep"] })`.

The module's description lists the names code can import. With a function of tools, the function is called again each time the backend describes itself, so the `exec` tool, built after the Workspace, sees the current list. A list is read as given; any other iterable may be single-use, so it is not read for the description, and neither is a function that throws.

### `codemode:container`

`createContainerModule()` from `@cloudflare/computer/modules/container` lets JavaScript run shell commands in the Workspace's container backend. With it, JavaScript is the only backend the model sees, and the container is something that JavaScript can call:

```ts
import { ContainerBackend, withWorkspaceContainer } from "@cloudflare/computer/backends/container";

class Agent extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [
      new CodemodeBackend({
        loader: this.env.LOADER,
        access: "read-write",
        modules: { "codemode:container": createContainerModule() },
      }),
      new ContainerBackend({
        container: () => this,
        workspace: { binding: "Agent", id: this.ctx.id.toString() },
        egress: { mode: "direct" },
      }),
    ],
  });
}

// Offer only the codemode backend; the container is reached through codemode:container.
const tools = createAITools({ workspace: this.workspace, exec: { backends: { codemode: {} } } });
```

```js
import { exec } from "codemode:container";

export default async function () {
  const { exitCode, stdout, stderr } = await exec("npm test", { cwd: "/workspace/app" });
  return { passed: exitCode === 0, stdout, stderr };
}
```

`exec(command, { cwd, env, stdin, timeoutMs })` runs through `workspace.runtime.exec` on the container backend: `ContainerBackend`, registered as `"container-shell"` unless you pass `backend`. If that backend is missing, or runs module source rather than shell commands, the codemode backend fails to connect. The container shares the Workspace's files: writes the module made before the call are pushed to the container, and the container's changes are pulled back before `exec` returns. A non-zero exit code comes back as a value, not as an error.

The result also carries `sync`: `{ status, skipped, skippedCount, error? }`. `status` is `pending` when the container's file changes have not reached the Workspace yet, and `error` says why. `skipped` lists up to 100 paths the container wrote that the Workspace refused, such as files in a read-only mount, and `skippedCount` gives the full count. The sync is last-writer-wins: the container's changes replace files written in the Workspace while the command runs, without reporting them as skipped. Don't write files from the isolate that the running command also writes.

A few limits follow from `exec` being a host call:

- Output comes back when the command finishes, not while it runs. Each stream keeps its last 2000 lines or `maxOutputBytes` (64 KiB by default), which must stay well under the backend's `maxCapabilityBytes`. When a stream is cut, the result's `truncated.stdout.path` (or `stderr`) names a Workspace file holding all of it (see [Long output](./05_runtime_interface.md#long-output)), and the host never holds more than the end in memory. The default directory, `/.computer/output`, is outside the backend's default `root` (`/workspace`), so isolate code cannot open it with `node:fs`; the agent's `read` and `grep` tools can. Set the Workspace's `output.dir` under `root` if isolate code needs to read it. A Workspace with `output: false` saves nothing and leaves output whole, so the module cuts each stream to the same limits itself and starts it with a note such as `[truncated, showing lines 2001-4000 of 4000]` in place of `truncated`.
- The command's timeout is capped at the time left before the host call deadline (`maxHostCallMs`, which defaults to `maxTimeoutMs`). Raise `defaultTimeoutMs`, `maxTimeoutMs`, and `maxHostCallMs` for slow installs and builds, and remember the container's first start.
- Cancelling the execution kills the running command.

A container command can write to the Workspace, so `exec` refuses to run on a read-only backend. Whether it can reach the network follows `ContainerBackend`'s own `egress` setting, not the codemode backend's.

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

### `codemode:exec`

`createExecModule()` from `@cloudflare/computer/remote-exec` runs a command in any container Durable Object, not only the Workspace's container backend. The files the command names are pushed into the container before it runs, and the files it changed are pulled back after. The container needs the `remote-exec` binary, and nothing else. `exec()` returns a process shaped exactly like `ctx.container.exec()`'s, with streams, `exitCode`, `output()` and `kill()`, and it works in replayable runs too. Experimental. Setup and options are in [20. Remote exec](./20_remote_exec.md).

### `codemode:browser`

`createBrowserModule()` from `@cloudflare/computer/modules/browser` gives JavaScript the agent's persistent browser: an agents `Browser` (from `agents/browser`, version 0.33.0 or later). The exports are the same `browser.*` functions `browserTool` gives its code, so code imports the module as a namespace and reads the same:

```js
import * as browser from "codemode:browser";

export default async function () {
  await browser.cdp({ method: "Page.navigate", params: { url: "https://example.com" }, sessionId: "active" });
  const { result } = await browser.cdp({
    method: "Runtime.evaluate",
    params: { expression: "document.title", returnByValue: true },
    sessionId: "active",
  });
  return result.value;
}
```

The module keeps its browser session in a scoped context. A run opens one browser session on its first call to the module and closes it when the run waits in `ctx.interrupt()` or ends, which saves its active tab, so the next run, or the next `browserTool` call, picks up where it left off. When the run ends, the session's notices, such as "the browser was restarted", are written to its stderr after its output, along with how long it waited for its turn if that was a second or more. Nothing reaches stderr while the code runs, so replay's output check holds. Every function takes one input object. `cdp` is marked `unsafeToRepeat()`, since a command may submit a form; the rest are safe to repeat. The browser keeps its logins and can change things on the sites it visits, so every function refuses to run on a read-only backend, as `codemode:container`'s `exec` does.

The browser scope says which tab a run drives: runs in one browser scope share an active tab, while cookies and logins are shared by every browser scope. Without a `scope` option, every run uses the `"shared"` browser scope. Pass a string, such as `scope: "research"`, to use another, or a function that picks one from the run's `{ id, metadata }` (see [Run metadata](./09_tool_interface.md#run-metadata) for how a run gets its metadata):

```ts
createBrowserModule({
  browser: this.browser,
  scope: ({ metadata }) => (metadata.user ? `user:${metadata.user}` : "shared"),
});
```

The function may throw instead, when a run without that metadata shouldn't browse. An empty browser scope is rejected.

Runs in one browser scope take turns, like `browserTool` calls, because they would otherwise see each other's navigation: pi and the AI SDK run a message's tool calls in parallel. A run takes its turn at its first browser call and keeps it until it ends, and runs that never call the module never wait. A run gives up after `lockTimeoutMs` (45 seconds by default) with an error saying why; keep it under the run's timeout and the backend's `maxHostCallMs`. A run that browsed and is waiting for a person keeps its browser scope while it waits: its session is closed, and other runs' first calls in that browser scope fail at once, saying the browser is held by a run that's waiting for a person. A run that took its turn while one ahead of it paused fails the same way. The module remembers which runs browsed in memory, so after the Durable Object restarts, a waiting run holds nothing until it resumes. Once that run resumes, it takes its turn again only at its first new browser call, since replay answers its earlier calls from the journal.

Don't expose `browserTool` to code through `codemode:tools` alongside this module. A run calling it would wait for its own turn until the host call timed out. The module's description says so, naming `toolsSpecifier` (`codemode:tools` by default) as it names `specifier` (`codemode:browser` by default) in its import line, and also tells the model to save screenshots to a file with `node:fs` and open them with `read`, to take about eight per run (each host call returns at most 1 MiB, and a run's calls share 8 MiB each way), and to work on several pages inside one run rather than across runs started together. The backend adds that description to its own, which the `exec` tool shows. An app that writes `exec`'s description itself must include it, from `backend.description`.

The module is experimental and may change in any release.

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
