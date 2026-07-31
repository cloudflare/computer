# Workspace execution runtimes

Workspace exposes one execution namespace:

```ts
const handle = await workspace.runtime.exec(source, {
  backend: "container-shell",
  cwd: "/workspace",
  encoding: "utf8",
});
const result = await handle.result();
```

The selected backend defines how it interprets `source`.

| Backend | Source language | Intended use |
| --- | --- | --- |
| `container-shell` | shell command | Full Linux, native binaries, installed packages, processes |
| `isolate-shell` | just-bash command | Fast text tools and Workspace Git without a Container |
| `isolate-javascript` | ECMAScript module | Isolated structured JavaScript with trusted Workspace modules |

Applications may register additional command or module backends under their own IDs. Backend IDs are part of the execution contract: changing the backend may change the source language.

## Lifecycle

```ts
const handle = await workspace.runtime.exec(source, {
  id: "build-1",
  backend: "isolate-javascript",
});

handle.id;
await handle.kill();

const resumed = await workspace.runtime.getExec("build-1", {
  backend: "isolate-javascript",
  resume: "full",
});

await workspace.runtime.disposeExec("build-1", {
  backend: "isolate-javascript",
});
```

The common result contains process-compatible output and an optional structured value:

```ts
interface WorkspaceRuntimeResult {
  status: "completed" | "failed" | "cancelled";
  exitCode: number;
  stdout: Uint8Array | string;
  stderr: Uint8Array | string;
  value?: WorkspaceRuntimeValue;
  pushed: number;
  pulled: number;
  skipped: SkippedEntry[];
}
```

Command backends leave `value` unset. Module backends use it for their structured return value.

`container-shell` retains the existing computerd process lifecycle. `isolate-javascript` keeps an execution journal in the Workspace database and retains events/results until `disposeExec`. Active isolate cancellation is host-driven by disposing the child Worker. An execution left running across a Workspace host restart is reconciled to failed because a live Worker capability cannot be serialized into SQLite.

`isolate-shell` intentionally retains its existing behavior in this release: it buffers a just-bash call to completion, does not retain cross-request events, and cannot reattach by ID. Callers that require supervised process behavior should use `container-shell`; callers that require a managed isolate should use `isolate-javascript`.

## Backend authority

There is no general `workspace.scope()` abstraction. Backend construction fixes maximum authority and module availability. A public gateway must validate which backend a signed capability is allowed to select.

For different authority levels, configure distinct backend instances:

```ts
new IsolateJavaScriptBackend({
  id: "isolate-javascript-readonly",
  loader: env.LOADER,
  access: "read",
});

new IsolateJavaScriptBackend({
  id: "isolate-javascript",
  loader: env.LOADER,
  access: "read-write",
});
```

The backend argument is never itself authorization.

See [17. Isolate JavaScript](./17_isolate_javascript.md) for module and trusted-package behavior.
