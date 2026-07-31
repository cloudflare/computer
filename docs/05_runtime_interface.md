# 05. Runtime interface

Workspace exposes one execution router:

```ts
const handle = await workspace.runtime.exec(source, {
  backend: "container-shell",
  cwd: "/workspace",
  encoding: "utf8",
});

const result = await handle.result();
```

The backend ID defines how `source` is interpreted. The shipped
container and worker backends treat it as shell syntax. Module backends
can use the same surface for structured code execution.

## API

```ts
interface WorkspaceRuntime {
  exec(source: string, options?: WorkspaceRuntimeExecOptions): Promise<WorkspaceRuntimeExecHandle>;
  getExec(id: string, options?: WorkspaceRuntimeGetOptions): Promise<WorkspaceRuntimeExecHandle>;
  killExec(id: string, options?: WorkspaceRuntimeKillOptions): Promise<void>;
  disposeExec(id: string, options?: WorkspaceRuntimeDisposeOptions): Promise<void>;
}

interface WorkspaceRuntimeExecOptions {
  id?: string;
  backend?: string;
  cwd?: string;
  encoding?: "utf8";
  input?: WorkspaceRuntimeValue;
  timeoutMs?: number;
}

interface WorkspaceRuntimeExecHandle extends ReadableStream<WorkspaceRuntimeEvent> {
  readonly id: string;
  readonly backend: string;
  result(): Promise<WorkspaceRuntimeResult>;
  kill(signal?: KillSignal): Promise<void>;
  [Symbol.dispose](): void;
}
```

`input` is accepted by structured module backends and rejected by command
backends. `cwd` is the command working directory or, for module backends,
the base path for backend-specific resolution. A handle is single-consumer:
call `result()` or consume its event stream, not both. Repeated `result()`
calls return the same promise. `backend` records the resolved backend needed
for later reattachment.

## Results

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
  sync:
    | { status: "complete"; applied: number; skipped: SkippedEntry[] }
    | { status: "pending"; applied: number; skipped: SkippedEntry[]; error: string };
}
```

Command backends leave `value` unset. Module backends can use `value` for a
structured return value. A command can complete while its post-command pull
fails; in that case `sync.status` is `"pending"`, and a configured
`SyncRetryScheduler` can durably retry the pull without rerunning the
command.

## Backend routing

```ts
await workspace.runtime.exec("grep -R TODO .", {
  backend: "isolate-shell",
});

await workspace.runtime.exec("npm test", {
  backend: "container-shell",
});
```

Omitting `backend` selects the first configured backend. Backend selection is
routing, not authorization; public gateways must validate it against
server-side policy.

## Command synchronization

Command backends continue to use the existing synchronization bracket:

```text
push → spawn → events/result → pull
```

A backend with `sync: "none"`, such as `isolate-shell`, shares the host
store and reports zero push/pull counts. A container has its own VFS and
synchronizes changes before and after command execution. Fully draining
either `result()` or the event stream completes the post-command pull before
the stream closes.

Module backends use host capability calls against the authoritative
Workspace and therefore require no push/pull round trip.

## Lifecycle differences

`container-shell` provides computerd's retained process log, replay,
signals, and disposal.

`isolate-shell` intentionally preserves one-call, buffered-result behavior
in this release. It does not retain executions for later reattachment or
disposal. `timeoutMs` and a concurrent `killExec()` for a caller-supplied
execution ID cooperatively abort just-bash at statement boundaries; by the
time an ordinary `exec()` promise returns, the command has already settled.
Use the container backend when detached execution and retained lifecycle are
required.
