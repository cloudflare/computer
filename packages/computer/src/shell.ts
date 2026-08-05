// Host-side WorkspaceShell facade.
//
// Wraps the ShellRPC half of a WorkspaceRPC stub. The docs/05
// contract: one entry point — exec() — that returns a detached
// handle. Callers either await `result()` (run-and-wait) or
// consume the ReadableStream directly (run-and-stream), or drop
// the handle entirely (fire-and-forget).
//
// Every exec() call brackets the spawn with the docs/05 sync
// frames:
//   - pushOnce(db, rpc.sync) runs *before* the spawn so any
//     host-side writes since the last push are visible to the
//     command.
//   - pullOnce(db, rpc.sync) runs *after* the stream drains (i.e.
//     after the exit event), so anything the command produced is
//     visible to subsequent Workspace.fs reads.
// The pushed / pulled counts land in ExecResult.
//
// Pull fires after either result() or direct stream consumption drains
// the execution events. The stream does not close until that pull settles.
//
// get() (reattach) is intentionally not bracketed. Reattaching
// to an already-running exec doesn't represent a new push frame.
// The result() of a reattached handle reports pushed = 0 and the
// pulled count from a pull that runs after its own drain — best-
// effort, can be 0 if nothing landed in computerd between reattach and
// drain.

import type { ExecEvent, ShellRPC } from "@cloudflare/computer-rpc";
import type { ApplyResult, SkippedEntry } from "@cloudflare/dofs";

import { noopAudit, openGate, type WorkspaceAudit, type WorkspaceGate, withGate } from "./gate.js";
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

export interface ExecResult<E extends ExecEncoding = undefined> {
  exitCode: number;
  stdout: Chunk<E>;
  stderr: Chunk<E>;
  // VFS sync stats from the docs/05 bracket.
  //   pushed  — entries shipped by the pre-exec pushOnce.
  //   pulled  — entries the post-drain pullOnce applied locally.
  //   skipped — entries the post-drain pullOnce did not apply,
  //             either because they targeted a read-only mount
  //             root or because the command ran without write
  //             access and the pull refused everything it was
  //             offered. Always empty for a backend that shares
  //             the workspace store: there is no pull to refuse,
  //             and a write fails inside the command instead.
  // pushed is observed before the stream is returned. The remaining
  // fields describe the post-command pull when result() is used.
  pushed: number;
  pulled: number;
  skipped: SkippedEntry[];
  // Structured post-command sync outcome. The legacy pulled and
  // skipped fields remain available for existing callers.
  sync: ExecSyncResult;
}

export type KillSignal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";

// ExecHandle is a ReadableStream<WorkspaceExecEvent> with three
// extras tacked on. Implemented as the wire stream + extra own
// properties (id / result / kill) rather than a subclass for two
// reasons:
//
//   1. The wire stream comes back from capnweb already built;
//      subclassing means a pump-through layer that copies every
//      chunk for no behavioural gain.
//   2. pipeThrough (used for the utf8 transform) returns a plain
//      ReadableStream, so the subclass identity gets lost on the
//      first transform anyway.
export interface ExecHandle<E extends ExecEncoding = undefined>
  extends ReadableStream<WorkspaceExecEvent<E>> {
  readonly id: string;
  result(): Promise<ExecResult<E>>;
  kill(signal?: KillSignal): Promise<void>;
  [Symbol.dispose](): void;
}

export interface ExecOptions<E extends ExecEncoding = undefined> {
  // Stable id. If omitted the runner mints a UUID. Reusing an id
  // while a previous run is still active throws EEXEC_BUSY.
  id?: string;
  // Absolute path inside the container. Defaults to the
  // workspace root.
  cwd?: string;
  // Encoding for stdout/stderr value payloads. Default is
  // Uint8Array; "utf8" decodes per-chunk through a stream-mode
  // TextDecoder so multi-byte boundaries survive.
  encoding?: E;
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
  // Backend selector. Omit to use the default backend (the first
  // one passed to the Workspace constructor); pass the id of
  // another configured backend to route this call there.
  backend?: string;
  // Whether this command may modify the workspace. Defaults to true.
  // Pass false for a command expected only to read: writes it
  // attempts then fail rather than land silently.
  //
  // The point is the misclassified command. A caller that decides
  // `git log` is read-only and is wrong about it — an alias, a shell
  // function, a `;` it did not parse — gets a failure it can see
  // instead of a mutation it did not intend. Which failure depends on
  // the backend: one that works directly against the workspace store
  // fails the write inside the command with EROFS, and one with its
  // own copy of the files has the change refused on the way back,
  // reported in `skipped`.
  //
  // A configured gate can withdraw write access even when this is
  // true, so a command may end up read-only without the caller
  // asking. It can never gain access this way.
  writable?: boolean;
}

export interface GetExecOptions<E extends ExecEncoding = undefined> {
  encoding?: E;
  // "tail" yields only events produced after this call. A
  // number resumes from that seq+1. Omit to receive every
  // event from the start of the run (replays the whole log).
  resume?: "tail" | "full" | number;
  // Backend selector. Same shape as ExecOptions.backend; routes
  // the get / reattach to the named backend.
  backend?: string;
}

// Push/pull bracket plumbing. WorkspaceShell doesn't know about
// the local Database or the SyncRPC wire — the host wires both
// behind a Sync object that exposes the entry counts.
// Workspace itself satisfies this interface (push() / pull() are
// public methods); tests pass a plain { push, pull } object.
// pull() returns the dofs ApplyResult so the shell can surface
// skipped read-only entries on ExecResult.
export interface Sync {
  push(): Promise<number>;
  // The post-command pull carries the command's write access, so a
  // command that ran read-only cannot have its changes applied by the
  // bracket that follows it.
  pull(options?: { writable?: boolean }): Promise<ApplyResult>;
  onPullPending?(error: unknown): Promise<void>;
}

export interface WorkspaceShellHooks {
  gate?: WorkspaceGate;
  audit?: WorkspaceAudit;
}

export class WorkspaceShell {
  readonly #shell: ShellRPC;
  readonly #sync: Sync;
  readonly #observer: WorkspaceObserver;
  readonly #gate: WorkspaceGate;
  readonly #audit: WorkspaceAudit;

  constructor(
    shell: ShellRPC,
    sync: Sync,
    observer: WorkspaceObserver = noopObserver,
    hooks: WorkspaceShellHooks = {},
  ) {
    this.#shell = shell;
    this.#sync = sync;
    this.#observer = observer;
    this.#gate = hooks.gate ?? openGate;
    this.#audit = hooks.audit ?? noopAudit;
  }

  exec(command: string): Promise<ExecHandle<undefined>>;
  exec(command: string, options: ExecOptions<undefined>): Promise<ExecHandle<undefined>>;
  exec(command: string, options: ExecOptions<"utf8">): Promise<ExecHandle<"utf8">>;
  async exec<E extends ExecEncoding>(
    command: string,
    options: ExecOptions<E> = {},
  ): Promise<ExecHandle<E>> {
    assertNotTemplate(command);
    // The gate runs before the push, so a denied command does not
    // move data. It is consulted once for the whole command; see
    // ./gate.ts for why a write-by-write gate would be worse.
    //
    // The audit hook fires here too, on the spawn, rather than after
    // the command exits. exec() returns a detached handle that the
    // caller may never drain, so there is no later point that is
    // guaranteed to arrive. What the command then did is on the
    // observer's span and on ExecResult.
    return withGate(
      this.#gate,
      this.#audit,
      {
        kind: "shell.exec",
        command,
        cwd: options.cwd,
        writable: options.writable ?? true,
        backend: options.backend,
      },
      (writable) => this.#spawn<E>(command, options, writable),
    );
  }

  async #spawn<E extends ExecEncoding>(
    command: string,
    options: ExecOptions<E>,
    writable: boolean,
  ): Promise<ExecHandle<E>> {
    // Pre-exec push: ship anything the host wrote since the last
    // push so the spawned command sees it. Failures non-fatal per
    // docs/05 — the command still runs; pushed reports 0.
    let pushed = 0;
    try {
      pushed = await this.#sync.push();
    } catch {
      // pushed stays 0
    }
    const envelope = await withSpan(
      this.#observer,
      "workspace.runtime.exec.spawn",
      {
        "workspace.runtime.cwd": options.cwd,
        "workspace.runtime.timeout_ms": options.timeoutMs,
        "workspace.runtime.id": options.id,
        "workspace.runtime.writable": writable,
      },
      () =>
        this.#shell.exec({
          command,
          id: options.id,
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          env: options.env,
          stdin:
            typeof options.stdin === "string"
              ? new TextEncoder().encode(options.stdin)
              : options.stdin,
          writable,
        }),
      (span, outcome) => {
        if (outcome.ok) span.setAttribute("workspace.runtime.id", outcome.value.id);
      },
    );
    // Dispose the result envelope when the event stream finishes
    // draining. Without this, capnweb's exports table holds onto
    // the envelope for the life of the session — one entry per
    // exec call — because we hand the inner stream off to the
    // caller and can't `using` the envelope ourselves.
    const events = disposeOnDone(envelope.events, () => maybeDispose(envelope));
    return wrapHandle<E>(
      this.#shell,
      this.#sync,
      envelope.id,
      events,
      options.encoding,
      pushed,
      writable,
    );
  }

  get(id: string): Promise<ExecHandle<undefined>>;
  get(id: string, options: GetExecOptions<undefined>): Promise<ExecHandle<undefined>>;
  get(id: string, options: GetExecOptions<"utf8">): Promise<ExecHandle<"utf8">>;
  async get<E extends ExecEncoding>(
    id: string,
    options: GetExecOptions<E> = {},
  ): Promise<ExecHandle<E>> {
    const after = resumeToAfter(options.resume);
    const envelope = await this.#shell.getExec({ id, after });
    const events = disposeOnDone(envelope.events, () => maybeDispose(envelope));
    // Reattach doesn't own the original push frame: pushed = 0.
    // The post-drain pull still fires, scoped to whatever lands
    // between reattach and the next drain.
    return wrapHandle<E>(this.#shell, this.#sync, id, events, options.encoding, 0);
  }

  kill(id: string, signal?: KillSignal, _options: { backend?: string } = {}): Promise<void> {
    return this.#shell.killExec({ id, signal });
  }

  dispose(id: string): Promise<void>;
  dispose(id: string, options: { backend?: string }): Promise<void>;
  dispose(id: string, _options: { backend?: string } = {}): Promise<void> {
    return this.#shell.disposeExec({ id });
  }
}

function resumeToAfter(resume: "tail" | "full" | number | undefined): number | "tail" | undefined {
  if (resume === undefined || resume === "full") return undefined;
  if (resume === "tail") return "tail";
  return resume;
}

// Stitch the runtime extras (id, result, kill) onto a fresh
// ReadableStream that pipes from the wire stream and applies any
// encoding conversion in flight.
//
// The user stream remains the only reader so backpressure reaches the backend.
// kill() requests a signal; result() or stream completion observes the exit.
function wrapHandle<E extends ExecEncoding>(
  shell: ShellRPC,
  sync: Sync,
  id: string,
  wireEvents: ReadableStream<ExecEvent>,
  encoding: E | undefined,
  pushed: number,
  writable = true,
): ExecHandle<E> {
  const postPull = withPostPull(pipeEvents<E>(wireEvents, encoding), sync, writable);
  const stream = postPull.stream;
  const handle = stream as ExecHandle<E>;
  let resultPromise: Promise<ExecResult<E>> | undefined;
  let resultReader: ReadableStreamDefaultReader<WorkspaceExecEvent<E>> | undefined;
  // configurable: true on result/kill lets the Workspace-level
  // router redefine them to add cross-cutting concerns (transport
  // failure invalidation on result(); future kill hooks). The id
  // slot stays non-configurable — nothing should rewrite it.
  Object.defineProperties(handle, {
    id: { value: id, enumerable: false, writable: false, configurable: false },
    result: {
      value: () => {
        resultPromise ??= drainToResult<E>(stream, encoding, pushed, postPull.outcome, (reader) => {
          resultReader = reader;
        });
        return resultPromise;
      },
      enumerable: false,
      writable: false,
      configurable: true,
    },
    kill: {
      value: (signal?: KillSignal) => shell.killExec({ id, signal }),
      enumerable: false,
      writable: false,
      configurable: true,
    },
    [Symbol.dispose]: {
      value: () => {
        if (resultReader) void resultReader.cancel().catch(() => undefined);
        else void stream.cancel().catch(() => undefined);
      },
    },
  });
  return handle;
}

function pipeEvents<E extends ExecEncoding>(
  source: ReadableStream<ExecEvent>,
  encoding: E | undefined,
): ReadableStream<WorkspaceExecEvent<E>> {
  if (encoding !== "utf8") {
    // Identity pipe — the wire shape already matches.
    return source as unknown as ReadableStream<WorkspaceExecEvent<E>>;
  }
  // Per-stream TextDecoders preserve multi-byte boundaries
  // across chunk splits.
  const stdoutDec = new TextDecoder("utf-8", { fatal: false });
  const stderrDec = new TextDecoder("utf-8", { fatal: false });
  let stdoutMeta: { id: string; seq: number } | undefined;
  let stderrMeta: { id: string; seq: number } | undefined;
  let lastSeq = 0;
  const enqueue = (
    controller: TransformStreamDefaultController<WorkspaceExecEvent<E>>,
    event: WorkspaceExecEvent<E>,
  ) => {
    lastSeq = event.seq;
    controller.enqueue(event);
  };
  const flushPending = (
    controller: TransformStreamDefaultController<WorkspaceExecEvent<E>>,
    beforeSeq?: number,
  ) => {
    const pending: Array<{
      id: string;
      seq: number;
      name: "stdout" | "stderr";
      value: Chunk<E>;
    }> = [];
    const stdout = stdoutDec.decode();
    const stderr = stderrDec.decode();
    if (stdout && stdoutMeta) {
      pending.push({ ...stdoutMeta, name: "stdout", value: stdout as Chunk<E> });
    }
    if (stderr && stderrMeta) {
      pending.push({ ...stderrMeta, name: "stderr", value: stderr as Chunk<E> });
    }
    pending.sort((a, b) => a.seq - b.seq);
    const span = beforeSeq !== undefined && beforeSeq > lastSeq ? beforeSeq - lastSeq : 1;
    for (let index = 0; index < pending.length; index++) {
      const event = pending[index];
      enqueue(controller, {
        ...event,
        seq: lastSeq + (span * (index + 1)) / (pending.length + 1),
      });
    }
    stdoutMeta = undefined;
    stderrMeta = undefined;
  };
  return source.pipeThrough(
    new TransformStream<ExecEvent, WorkspaceExecEvent<E>>({
      transform(event, controller) {
        if (event.name === "stdout") {
          stdoutMeta = { id: event.id, seq: event.seq };
          enqueue(controller, {
            id: event.id,
            seq: event.seq,
            name: "stdout",
            value: stdoutDec.decode(event.value, { stream: true }) as Chunk<E>,
          });
        } else if (event.name === "stderr") {
          stderrMeta = { id: event.id, seq: event.seq };
          enqueue(controller, {
            id: event.id,
            seq: event.seq,
            name: "stderr",
            value: stderrDec.decode(event.value, { stream: true }) as Chunk<E>,
          });
        } else {
          flushPending(controller, event.seq);
          enqueue(controller, event as WorkspaceExecEvent<E>);
        }
      },
      flush: flushPending,
    }),
  );
}

interface PostPullOutcome {
  applied: number;
  skipped: SkippedEntry[];
  sync: ExecSyncResult;
}

function withPostPull<E extends ExecEncoding>(
  source: ReadableStream<WorkspaceExecEvent<E>>,
  sync: Sync,
  writable: boolean,
): { stream: ReadableStream<WorkspaceExecEvent<E>>; outcome: Promise<PostPullOutcome> } {
  const reader = source.getReader();
  let resolveOutcome!: (outcome: PostPullOutcome) => void;
  const outcome = new Promise<PostPullOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const stream = new ReadableStream<WorkspaceExecEvent<E>>(
    {
      async pull(controller) {
        try {
          const next = await reader.read();
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }
          reader.releaseLock();
          const pulled = await runPostPull(sync, writable);
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

async function runPostPull(sync: Sync, writable: boolean): Promise<PostPullOutcome> {
  try {
    // The command's write access travels with its own post-command
    // pull. Without this the bracket would apply exactly the changes
    // the command was not allowed to make.
    const result = await sync.pull({ writable });
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

async function drainToResult<E extends ExecEncoding>(
  stream: ReadableStream<WorkspaceExecEvent<E>>,
  encoding: E | undefined,
  pushed: number,
  postPull: Promise<PostPullOutcome>,
  setReader: (reader: ReadableStreamDefaultReader<WorkspaceExecEvent<E>> | undefined) => void,
): Promise<ExecResult<E>> {
  const reader = stream.getReader();
  setReader(reader);
  const stdoutParts: Array<Chunk<E>> = [];
  const stderrParts: Array<Chunk<E>> = [];
  let exitCode = -1;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.name === "stdout") stdoutParts.push(value.value);
      else if (value.name === "stderr") stderrParts.push(value.value);
      else exitCode = value.value;
    }
  } finally {
    reader.releaseLock();
    setReader(undefined);
  }
  const pulled = await postPull;
  return {
    exitCode,
    stdout: joinParts<E>(stdoutParts, encoding),
    stderr: joinParts<E>(stderrParts, encoding),
    pushed,
    pulled: pulled.applied,
    skipped: pulled.skipped,
    sync: pulled.sync,
  };
}

function joinParts<E extends ExecEncoding>(
  parts: Array<Chunk<E>>,
  encoding: E | undefined,
): Chunk<E> {
  if (parts.length === 0) {
    return (encoding === "utf8" ? "" : new Uint8Array(0)) as Chunk<E>;
  }
  if (typeof parts[0] === "string") {
    return (parts as string[]).join("") as Chunk<E>;
  }
  const arrays = parts as Uint8Array[];
  const total = arrays.reduce((acc, a) => acc + a.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out as Chunk<E>;
}

// Wrap `stream` so its capnweb envelope is released exactly once on clean
// completion, source failure, or consumer cancellation.
function disposeOnDone<T>(stream: ReadableStream<T>, onDone: () => void): ReadableStream<T> {
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
function maybeDispose(value: unknown): void {
  const d = (value as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose];
  if (typeof d === "function") d.call(value);
}
