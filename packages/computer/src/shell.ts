// Host-side command executor.
//
// Wraps the ShellRPC half of a WorkspaceRPC stub and presents it as
// the unified execution surface the Workspace runtime consumes:
// exec() spawns a command, get() reattaches to one, and both return
// an envelope of raw events plus the docs/05 sync bracket stats.
//
// Every exec() call brackets the spawn with the docs/05 sync frames:
//   - the pre-exec push ships any host-side writes since the last
//     push so the spawned command sees them.
//   - the post-drain pull runs after the event stream reaches its
//     end, so anything the command produced is visible to subsequent
//     Workspace.fs reads.
// The pushed count is known when the envelope is built; the pull
// outcome settles once the events stream drains. The runtime applies
// encoding and accumulates the result from the raw events.
//
// get() (reattach) is intentionally not push-bracketed. Reattaching
// to an already-running exec doesn't represent a new push frame, so
// it reports pushed = 0; the post-drain pull still fires, scoped to
// whatever landed between reattach and drain.

import type { ExecEvent, ShellRPC } from "@cloudflare/computer-rpc";
import type { ApplyResult, SkippedEntry } from "@cloudflare/dofs";

import { noopObserver, safeErrorMessage, type WorkspaceObserver, withSpan } from "./observe.js";
import { assertNotTemplate } from "./sh.js";

export type ExecEncoding = "utf8" | undefined;

// The payload type for stdout/stderr chunks: Uint8Array by
// default, string when the caller passes encoding: "utf8".
type Chunk<E extends ExecEncoding> = E extends "utf8" ? string : Uint8Array;

export type WorkspaceExecEvent<E extends ExecEncoding = undefined> =
  | { id: string; seq: number; name: "stdout"; value: Chunk<E> }
  | { id: string; seq: number; name: "stderr"; value: Chunk<E> }
  | { id: string; seq: number; name: "exit"; value: number };

export type ExecSyncResult =
  | { status: "complete"; applied: number; skipped: SkippedEntry[] }
  | { status: "pending"; applied: number; skipped: SkippedEntry[]; error: string };

export type KillSignal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";

// The envelope both exec() and get() return: an execution id, the
// raw (unencoded) event stream, and the sync bracket stats. The
// pushed count is known up front; `outcome` settles when `events`
// reaches its end, carrying the post-drain pull result.
export interface CommandExecution {
  id: string;
  runtimeId?: string;
  events: ReadableStream<ExecEvent>;
  sync: { pushed: number; outcome: Promise<PostPullOutcome> };
}

export interface ExecOptions {
  // Stable id. If omitted the runner mints a UUID. Reusing an id
  // while a previous run is still active throws EEXEC_BUSY.
  id?: string;
  // Absolute path inside the container. Defaults to the
  // workspace root.
  cwd?: string;
  // Per-call timeout in milliseconds. Past this duration the
  // container sends SIGTERM (then SIGKILL after a short grace).
  // Omit to use the runner's default (typically 320_000). Pass 0
  // to disable the timeout for this call.
  timeoutMs?: number;
  // Environment variables inherited by this command only. Values
  // override the backend's base environment without changing later
  // executions.
  env?: Record<string, string>;
  // Standard input fed to the command. Bytes, or a string encoded
  // as UTF-8.
  stdin?: Uint8Array | string;
}

export interface GetExecOptions {
  // "tail" yields only events produced after this call. A
  // number resumes from that seq+1. Omit to receive every
  // event from the start of the run (replays the whole log).
  resume?: "tail" | "full" | number;
  // Expected process identity for process-local replay. Internal to
  // the Workspace command adapter; direct ShellRPC callers omit it.
  runtimeId?: string;
}

// Push/pull bracket plumbing. CommandExecutor doesn't know about
// the local Database or the SyncRPC wire — the host wires both
// behind a Sync object that exposes the entry counts.
// Workspace itself satisfies this interface (push() / pull() are
// public methods); tests pass a plain { push, pull } object.
// pull() returns the dofs ApplyResult so the executor can surface
// skipped read-only entries on the sync outcome.
export interface Sync {
  push(): Promise<number>;
  pull(): Promise<ApplyResult>;
  onPullPending?(error: unknown): Promise<void>;
}

type ShellExecInput = Parameters<ShellRPC["exec"]>[0];
type ShellGetInput = Parameters<ShellRPC["getExec"]>[0] & { runtimeId?: string };
type ShellExecEnvelope = Awaited<ReturnType<ShellRPC["exec"]>> & { runtimeId?: string };

// Optional host-owned dispatch boundary. The container Workspace uses
// this to keep its pre-exec push and shell spawn on one backend handle;
// simpler executors use Sync.push followed by the supplied ShellRPC.
export interface CommandDispatchResult {
  pushed: number;
  envelope: ShellExecEnvelope;
}

export type CommandDispatch = (input: ShellExecInput) => Promise<CommandDispatchResult>;
export type CommandGetDispatch = (input: ShellGetInput) => Promise<ShellExecEnvelope>;

export class CommandExecutor {
  readonly #shell: ShellRPC;
  readonly #sync: Sync;
  readonly #observer: WorkspaceObserver;
  readonly #dispatch: CommandDispatch | undefined;
  readonly #getDispatch: CommandGetDispatch | undefined;

  constructor(
    shell: ShellRPC,
    sync: Sync,
    observer: WorkspaceObserver = noopObserver,
    dispatch?: CommandDispatch,
    getDispatch?: CommandGetDispatch,
  ) {
    this.#shell = shell;
    this.#sync = sync;
    this.#observer = observer;
    this.#dispatch = dispatch;
    this.#getDispatch = getDispatch;
  }

  // Spawn a command. Pushes host-side writes first so the command
  // sees them, then returns the raw event stream and the sync
  // bracket stats. A failed push aborts before shell.exec: running
  // with stale or incomplete workspace contents is not safe.
  async exec(source: string, options: ExecOptions = {}): Promise<CommandExecution> {
    assertNotTemplate(source);
    const input: ShellExecInput = {
      source,
      id: options.id,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      env: options.env,
      stdin:
        typeof options.stdin === "string" ? new TextEncoder().encode(options.stdin) : options.stdin,
    };
    let pushed: number;
    let envelope: ShellExecEnvelope;
    if (this.#dispatch !== undefined) {
      ({ pushed, envelope } = await this.#dispatch(input));
    } else {
      pushed = await this.#sync.push();
      envelope = await spawnShell(this.#shell, input, this.#observer);
    }
    // Dispose the RPC envelope when the event stream finishes
    // draining. Without this, capnweb's exports table holds onto
    // the envelope for the life of the session — one entry per exec
    // call — because the inner stream is handed off to the caller
    // and the envelope can't be bound with `using` here.
    const drained = disposeOnDone(envelope.events, () => maybeDispose(envelope));
    const { stream, outcome } = withPostPull(drained, this.#sync);
    return {
      id: envelope.id,
      runtimeId: envelope.runtimeId,
      events: stream,
      sync: { pushed, outcome },
    };
  }

  // Reattach to an in-flight or recently-completed exec. Reattach
  // does not own the original push frame, so pushed = 0; the
  // post-drain pull still fires, scoped to whatever landed between
  // reattach and drain.
  async get(id: string, options: GetExecOptions = {}): Promise<CommandExecution> {
    const after = resumeToAfter(options.resume);
    const envelope: ShellExecEnvelope =
      this.#getDispatch === undefined
        ? await this.#shell.getExec({ id, after })
        : await this.#getDispatch({ id, after, runtimeId: options.runtimeId });
    const drained = disposeOnDone(envelope.events, () => maybeDispose(envelope));
    const { stream, outcome } = withPostPull(drained, this.#sync);
    return { id, runtimeId: envelope.runtimeId, events: stream, sync: { pushed: 0, outcome } };
  }

  kill(id: string, signal?: KillSignal): Promise<void> {
    return this.#shell.killExec({ id, signal });
  }

  dispose(id: string): Promise<void> {
    return this.#shell.disposeExec({ id });
  }
}

export function spawnShell(
  shell: ShellRPC,
  input: ShellExecInput,
  observer: WorkspaceObserver = noopObserver,
): Promise<ShellExecEnvelope> {
  return withSpan(
    observer,
    "workspace.runtime.exec.spawn",
    {
      "workspace.runtime.cwd": input.cwd,
      "workspace.runtime.timeout_ms": input.timeoutMs,
      "workspace.runtime.id": input.id,
    },
    () => shell.exec(input),
    (span, outcome) => {
      if (outcome.ok) span.setAttribute("workspace.runtime.id", outcome.value.id);
    },
  );
}

function resumeToAfter(resume: "tail" | "full" | number | undefined): number | "tail" | undefined {
  if (resume === undefined || resume === "full") return undefined;
  if (resume === "tail") return "tail";
  return resume;
}

export interface PostPullOutcome {
  applied: number;
  skipped: SkippedEntry[];
  sync: ExecSyncResult;
}

export function withPostPull(
  source: ReadableStream<ExecEvent>,
  sync: Sync,
): { stream: ReadableStream<ExecEvent>; outcome: Promise<PostPullOutcome> } {
  const reader = source.getReader();
  let resolveOutcome!: (outcome: PostPullOutcome) => void;
  const outcome = new Promise<PostPullOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const stream = new ReadableStream<ExecEvent>(
    {
      async pull(controller) {
        try {
          const next = await reader.read();
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }
          reader.releaseLock();
          const pulled = await runPostPull(sync);
          resolveOutcome(pulled);
          controller.close();
        } catch (error) {
          try {
            reader.releaseLock();
          } catch {}
          resolveOutcome({
            applied: 0,
            skipped: [],
            sync: { status: "pending", applied: 0, skipped: [], error: safeErrorMessage(error) },
          });
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
          resolveOutcome({
            applied: 0,
            skipped: [],
            sync: { status: "pending", applied: 0, skipped: [], error: safeErrorMessage(reason) },
          });
        }
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, outcome };
}

async function runPostPull(sync: Sync): Promise<PostPullOutcome> {
  try {
    const result = await sync.pull();
    return {
      applied: result.applied,
      skipped: result.skipped,
      sync: { status: "complete", applied: result.applied, skipped: result.skipped },
    };
  } catch (error) {
    try {
      await sync.onPullPending?.(error);
    } catch {}
    return {
      applied: 0,
      skipped: [],
      sync: { status: "pending", applied: 0, skipped: [], error: safeErrorMessage(error) },
    };
  }
}

// Wrap `stream` so its capnweb envelope is released exactly once on clean
// completion, source failure, or consumer cancellation.
export function disposeOnDone<T>(stream: ReadableStream<T>, onDone: () => void): ReadableStream<T> {
  const reader = stream.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    try {
      reader.releaseLock();
    } catch {}
    try {
      onDone();
    } catch {
      // Disposer failures cannot be recovered at this boundary.
    }
  };
  return new ReadableStream<T>(
    {
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            finish();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

// Best-effort dispose of a capnweb result envelope. Real envelopes
// expose [Symbol.dispose]; test fakes return plain objects, so the
// symbol may be absent.
export function maybeDispose(value: unknown): void {
  const d = (value as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose];
  if (typeof d === "function") d.call(value);
}
