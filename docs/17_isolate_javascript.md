# Isolate JavaScript runtime

`IsolateJavaScriptBackend` runs an ECMAScript module in a fresh Cloudflare Dynamic Worker:

```ts
import { Workspace } from "@cloudflare/computer";
import { IsolateJavaScriptBackend } from "@cloudflare/computer/backends/javascript";

const workspace = new Workspace({
  storage: ctx.storage,
  waitUntil: ctx.waitUntil.bind(ctx),
  backends: [
    new IsolateJavaScriptBackend({
      loader: env.LOADER,
      root: "/workspace",
      access: "read-write",
      defaultTimeoutMs: 10_000,
      maxTimeoutMs: 30_000,
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
    backend: "isolate-javascript",
    input: { value: 21 },
    encoding: "utf8",
  },
);

const result = await handle.result();
// result.value = { value: 42, persisted: "42" }
```

The source is a real ES module. Static imports, literal dynamic imports, and top-level await are supported. If the module default-exports a function, Workspace invokes it with `options.input`. Otherwise module evaluation completes with a `null` structured result.

`waitUntil` is required for this backend. `runtime.exec()` returns before the Dynamic Worker finishes, so the host must attach completion to the Durable Object event lifetime. Construction fails when a module backend connects without this hook.

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
    backend: "isolate-javascript",
    cwd: "/workspace",
    input: { value: 42 },
  },
);
```

Workspace parses the graph before loading the Worker, confines every durable path, rejects symlink traversal, and enforces aggregate source, module-count, and import-depth limits. Dynamic imports must use string literals.

## Execution limits and retention

The backend admits one execution at a time by default. A concurrent start fails with `EEXEC_BUSY` instead of creating an unbounded number of Dynamic Workers. Set `maxConcurrentExecutions` only after measuring the Durable Object and Worker Loader limits for the deployment.

Each execution also bounds log events, active event subscribers, directory entries per read, concurrent and total capability calls, and cumulative capability request and response bytes. The corresponding `maxLogEvents`, `maxExecutionSubscribers`, `maxDirectoryEntries`, and `max*Capability*` options may be lowered for public workloads. Directory reads apply their limit in SQLite before materializing rows. Requests are checked inside the isolate before Workers RPC and again by the host.

Completed execution records remain available for replay for five minutes by default. The backend also keeps at most 100 completed records. Configure these bounds with `retentionMs` and `maxRetainedExecutions`. Completed records leave the in-memory active set immediately; replay reads them from SQLite.

Cancellation stops new host capability calls, disposes the Dynamic Worker, and waits for host calls that were already accepted. Exit 130 is published only after those calls settle. Normal completion uses the same drain rule, so an unawaited capability call cannot mutate the workspace after exit 0.

Host calls have a caller-visible deadline, controlled by `maxHostCallMs` and defaulting to `maxTimeoutMs`. Missing the deadline fails the capability call and marks the execution failed, even if caller code catches that error. Execution still waits for the accepted host operation itself before publishing a terminal event because many host APIs cannot roll back an external side effect after dispatch. Trusted modules receive an optional `{ signal, deadline }` context and must stop promptly when the signal aborts. A trusted module that ignores cancellation and never settles will keep execution in its finalizing state. `compatibilityDate` and `compatibilityFlags` control the Dynamic Worker runtime and default to the package-tested settings.

## Configured modules

Bare imports are installed at backend construction, not passed on individual executions:

```ts
new IsolateJavaScriptBackend({
  loader: env.LOADER,
  modules: {
    "tar-stream": TAR_STREAM_BUNDLE,
  },
});
```

Unknown bare imports fail before Worker creation. `node:fs` and `node:fs/promises` are host-installed exceptions backed by the durable Workspace. Configured modules are code, not host authority, and may not use the reserved `ws:` namespace or shadow either filesystem specifier.

## Trusted Workspace modules

Filesystem access uses the familiar asynchronous Node API, but is backed by the durable Workspace rather than an isolate-local filesystem. Both forms are installed automatically:

```js
import fs from "node:fs/promises";
// or: import { promises as fs } from "node:fs";

const text = await fs.readFile("/workspace/input.txt", "utf8");
await fs.writeFile("/workspace/output.txt", text.toUpperCase());
```

Supported promise APIs are `readFile`, `writeFile`, `mkdir`, `rm`, `chmod`, `symlink`, `readlink`, `readdir`, `stat`, `lstat`, and `access`. `readFile` returns bytes when encoding is omitted and supports `"utf8"` / `"utf-8"` for text; other encodings are rejected. `writeFile` supports the default `"w"` flag and exclusive `"wx"`; other Node flags are rejected, and—as in Node—the parent directory must already exist. Relative symlink targets are preserved by `readlink`, while reads and writes through symlinks are rejected by the Workspace confinement boundary. Synchronous and callback-style Node filesystem APIs are intentionally unavailable because every operation crosses the isolate-to-Workspace capability boundary.

The entire `ws:` namespace remains reserved for other Workspace-maintained host capabilities. The built-in runtime installs `ws:git` and `ws:artifacts`.

### `ws:git`

```js
import { clone, diff, status, log, cli } from "ws:git";
```

`ws:git` is explicit host authority rather than ambient isolate networking. Clone, fetch, pull, push, `ls-remote`, and submodule commands can perform host-side requests even when the Dynamic Worker has `globalOutbound: null`, so they are denied by default. Enable them only on a trusted backend construction with `allowGitNetwork: true`; local Git operations remain available without that authority. Remote `ws:artifacts.importArtifact()` is independently denied unless backend construction sets `allowArtifactNetwork: true`.

### `ws:artifacts`

```js
import {
  create,
  get,
  list,
  importArtifact,
  deleteArtifact,
} from "ws:artifacts";
```

These modules are sandbox-side shims over host RPC. Loader bindings, credentials, Durable Object storage, and unrestricted Workspace objects never enter user code. The host bridge checks the backend's fixed read/read-write authority on every mutation. Artifacts methods fail clearly when no Artifacts binding is configured.

Caller modules and durable files cannot shadow `node:fs`, `node:fs/promises`, or `ws:*`.

Path confinement rejects lexical escapes and every symlink component before an operation. These checks are not an atomic inode-style “resolve beneath root” primitive: do not treat one isolate capability as a security boundary against a separate, more privileged principal concurrently replacing paths in the same mutable Workspace. Deployments requiring that adversarial concurrency need a future transactional DOFS primitive or separate Workspace identities.

## Isolation and lifecycle

Each execution receives a fresh Dynamic Worker with:

- explicit Worker Loader CPU limits;
- a host wall-clock deadline;
- `globalOutbound: null` by default;
- finite, acyclic JSON-compatible input and structured result validation;
- configurable source/module graph, input, result, captured-log, file/capability request, and response byte limits (`maxSourceBytes`, `maxInputBytes`, `maxResultBytes`, `maxLogBytes`, and `maxCapabilityBytes`);
- explicit entrypoint and Worker disposal;
- host-owned cancellation;
- retained events and result rows in the Workspace database.

Console output is bounded but currently buffered in the Dynamic Worker and published when evaluation settles; the execution event stream provides replay/lifecycle semantics rather than live JavaScript console streaming. Completed writes are durable immediately. Failure or cancellation does not roll back filesystem effects already completed.

## Trusted integrations

A host can configure additional reserved capability modules through `IsolateJavaScriptBackend.trustedModules`; these modules are fixed when the backend is constructed and cannot be supplied or replaced by caller source.
