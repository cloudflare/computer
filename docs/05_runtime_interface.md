# 05. Runtime Interface

Workspace exposes one execution router:

```ts
const handle = await workspace.runtime.exec(source, {
  backend: "container-shell",
  cwd: "/workspace",
  encoding: "utf8",
});

const result = await handle.result();
```

The backend ID defines how `source` is interpreted. Command runtimes accept shell syntax; module runtimes accept their documented programming language.

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
  env?: Record<string, string>;
  stdin?: Uint8Array | string;
  writable?: boolean;
}

interface WorkspaceRuntimeExecHandle extends ReadableStream<WorkspaceRuntimeEvent> {
  readonly id: string;
  readonly backend: string;
  result(): Promise<WorkspaceRuntimeResult>;
  kill(signal?: KillSignal): Promise<void>;
  [Symbol.dispose](): void;
}
```

`input` is accepted by callable backends and rejected by the rest; it carries a structured value that the callable backend returns a structured value for. `env` is accepted everywhere: command backends inherit it for the spawned command, and the JavaScript module backend exposes it through `process.env`. Its values apply to that execution only and do not change later executions. `stdin` is the caller-supplied standard input, accepted by backends that model it (the JavaScript module backend reads it through `process.stdin`). `cwd` is the command working directory or the base for durable relative module imports. A handle is single-consumer: call `result()` or consume its event stream, not both. Repeated `result()` calls return the same promise. `backend` records the resolved backend needed for later reattachment.

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

Command backends leave `value` unset. `worker-javascript` uses `value` for the module's structured return value and reports a zero-entry completed sync. A command can complete while its post-command pull fails; in that case `sync.status` is `"pending"`, and a configured `SyncRetryScheduler` can durably retry the pull without rerunning the command.

## Backend routing

```ts
await workspace.runtime.exec("grep -R TODO .", {
  backend: "worker-shell",
});

await workspace.runtime.exec("npm test", {
  backend: "container-shell",
});

await workspace.runtime.exec(
  `
    import fs from "node:fs/promises";
    export default async () => fs.readFile("/workspace/package.json", "utf8");
  `,
  { backend: "worker-javascript" },
);
```

Omitting `backend` selects the first configured backend. Backend selection is routing, not authorization; public gateways must validate it against server-side policy.

## Write access

`writable` defaults to true. Pass `false` for a command expected only to read, and a write it attempts fails rather than lands. What that costs the command depends on the backend: `worker-shell` and `worker-javascript` share the host store and refuse the write where it happens, while a Container writes to its own copy and has the change refused on the way back, reported in `skipped` with reason `no-write-access`. A configured gate can also withdraw write access from a command that asked for it. See [20. Write access and approval](./20_approval.md).

## Command synchronization

Command backends continue to use the existing synchronization bracket:

```text
push → spawn → events/result → pull
```

A backend with `sync: "none"`, such as `worker-shell`, shares the host store and reports zero push/pull counts. A Container has its own VFS and synchronizes changes before and after command execution. Fully draining either `result()` or the event stream completes the post-command pull before the stream closes.

Module backends use host capability calls against the authoritative Workspace and therefore require no push/pull round trip.

## Lifecycle differences

`container-shell` provides computerd's retained process log, replay, signals, and disposal.

`worker-javascript` provides a Workspace-owned execution journal, retained result/events, host cancellation, and explicit disposal. Active Workers cannot be serialized across host restart; orphaned running records are reconciled to failed.

`worker-shell` intentionally preserves one-call, buffered-result behavior in this release. It does not retain executions for later reattachment or disposal. `timeoutMs` and a concurrent `killExec()` for a caller-supplied execution ID cooperatively abort just-bash at statement boundaries; by the time an ordinary `exec()` promise returns, the command has already settled. Use the Container or JavaScript isolate when detached execution and retained lifecycle are required.

See [16. Execution runtime architecture](./16_code_execution.md) and [17. Isolate JavaScript](./17_isolate_javascript.md).
