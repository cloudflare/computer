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

## Command synchronization

Command backends continue to use the existing synchronization bracket:

```text
push → spawn → events/result → pull
```

A backend with `sync: "none"`, such as `worker-shell`, shares the host store and reports zero push/pull counts. A Container has its own VFS and synchronizes changes before and after command execution. Fully draining either `result()` or the event stream completes the post-command pull before the stream closes.

The pre-command push is a safety gate, not a best-effort optimization. The push and spawn use the same backend handle. If that handle fails before dispatch, the reconnect retry repeats both steps on the replacement container so the command cannot skip its push. If the push still fails, `exec()` rejects before the spawn request is sent; `pushed: 0` means a successful push found no entries, not that synchronization failed. A failed post-command pull does not change the completed command result. The pull is fenced to the runtime UUID that ran the command, so reconnecting to an empty replacement cannot report a clean zero-entry sync. It reports `sync.status: "pending"`, persists that UUID with the retry intent, and can be resumed by the durable sync retry scheduler only if the original runtime is still available.

Container connection failures also get one backend-internal reconnect attempt. Sync calls are safe to repeat. `getExec`, `killExec`, and `disposeExec` are retried only when the new connection reaches the same computerd runtime; a replacement container returns `EEXEC_LOST` instead of applying an old execution id to its new process table. `shell.exec` is different: the backend retries it only when connection setup failed or a locally disposed stub proves that no request was sent. If the transport fails after computerd may have accepted the spawn, the error states that the command may have started and the backend does not replay it. A failure while reading the event stream also invalidates the connection without rerunning the command.

Module backends use host capability calls against the authoritative Workspace and therefore require no push/pull round trip.

## Lifecycle differences

`container-shell` provides computerd's retained process log, replay, signals, and disposal. Execution handles are scoped to the UUID of the container process that accepted them, so they cannot target a reused execution id after process replacement.

`worker-javascript` provides a Workspace-owned execution journal, retained result/events, host cancellation, and explicit disposal. Active Workers cannot be serialized across host restart; orphaned running records are reconciled to failed.

`worker-shell` intentionally preserves one-call, buffered-result behavior in this release. It does not retain executions for later reattachment or disposal. `timeoutMs` and a concurrent `killExec()` for a caller-supplied execution ID cooperatively abort just-bash at statement boundaries; by the time an ordinary `exec()` promise returns, the command has already settled. Use the Container or JavaScript isolate when detached execution and retained lifecycle are required.

See [16. Execution runtime architecture](./16_code_execution.md) and [17. Isolate JavaScript](./17_isolate_javascript.md).
