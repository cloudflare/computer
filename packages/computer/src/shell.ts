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
// Pull only fires when the caller awaits handle.result(). A
// caller that consumes the stream directly gets the push but not
// the pull — docs/05 puts the pull after the exit event, which
// only result() observes. If you need the pull in that flow,
// drive the stream yourself then call Workspace.pull() explicitly.
//
// get() (reattach) is intentionally not bracketed. Reattaching
// to an already-running exec doesn't represent a new push frame.
// The result() of a reattached handle reports pushed = 0 and the
// pulled count from a pull that runs after its own drain — best-
// effort, can be 0 if nothing landed in computerd between reattach and
// drain.

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

export interface ExecResult<E extends ExecEncoding = undefined> {
  exitCode: number;
  stdout: Chunk<E>;
  stderr: Chunk<E>;
  // VFS sync stats from the docs/05 bracket.
  //   pushed  — entries shipped by the pre-exec pushOnce.
  //   pulled  — entries the post-drain pullOnce applied locally.
  //   skipped — entries the post-drain pullOnce did NOT apply
  //             because they targeted a read-only mount root.
  //             Empty when no read-only mounts are registered or
  //             the container stayed clear of them.
  // pulled / skipped are populated only when handle.result() is
  // awaited. Consuming the stream directly leaves both at their
  // empty values; pushed is observed before the stream is returned
  // so it reflects the real push count either way.
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
  // Backend selector. Omit to use the default backend (the first
  // one passed to the Workspace constructor); pass the id of
  // another configured backend to route this call there.
  backend?: string;
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
  pull(): Promise<ApplyResult>;
  onPullPending?(error: unknown): Promise<void>;
}

export class WorkspaceShell {
  readonly #shell: ShellRPC;
  readonly #sync: Sync;
  readonly #observer: WorkspaceObserver;

  constructor(shell: ShellRPC, sync: Sync, observer: WorkspaceObserver = noopObserver) {
    this.#shell = shell;
    this.#sync = sync;
    this.#observer = observer;
  }

  exec(command: string): Promise<ExecHandle<undefined>>;
  exec(command: string, options: ExecOptions<undefined>): Promise<ExecHandle<undefined>>;
  exec(command: string, options: ExecOptions<"utf8">): Promise<ExecHandle<"utf8">>;
  async exec<E extends ExecEncoding>(
    command: string,
    options: ExecOptions<E> = {},
  ): Promise<ExecHandle<E>> {
    assertNotTemplate(command);
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
      "workspace.shell.exec.spawn",
      {
        "workspace.shell.cwd": options.cwd,
        "workspace.shell.timeout_ms": options.timeoutMs,
        "workspace.shell.id": options.id,
      },
      () =>
        this.#shell.exec({
          command,
          id: options.id,
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
        }),
      (span, outcome) => {
        if (outcome.ok) span.setAttribute("workspace.shell.id", outcome.value.id);
      },
    );
    // Dispose the result envelope when the event stream finishes
    // draining. Without this, capnweb's exports table holds onto
    // the envelope for the life of the session — one entry per
    // exec call — because we hand the inner stream off to the
    // caller and can't `using` the envelope ourselves.
    const events = disposeOnDone(envelope.events, () => maybeDispose(envelope));
    return wrapHandle<E>(this.#shell, this.#sync, envelope.id, events, options.encoding, pushed);
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
// The wire stream is tee'd so kill() can observe the exit event
// independently of whatever the caller does with the handle. kill()
// sends the signal then awaits the exit event so callers can rely on
// "resolved ⇒ child has exited" without having to drain the stream
// or await result() themselves.
function wrapHandle<E extends ExecEncoding>(
  shell: ShellRPC,
  sync: Sync,
  id: string,
  wireEvents: ReadableStream<ExecEvent>,
  encoding: E | undefined,
  pushed: number,
): ExecHandle<E> {
  const [forUser, forWatcher] = wireEvents.tee();
  const exited = watchForExit(forWatcher);
  const stream = pipeEvents<E>(forUser, encoding);
  const handle = stream as ExecHandle<E>;
  // configurable: true on result/kill lets the Workspace-level
  // router redefine them to add cross-cutting concerns (transport
  // failure invalidation on result(); future kill hooks). The id
  // slot stays non-configurable — nothing should rewrite it.
  Object.defineProperties(handle, {
    id: { value: id, enumerable: false, writable: false, configurable: false },
    result: {
      value: () => drainToResult<E>(stream, encoding, sync, pushed),
      enumerable: false,
      writable: false,
      configurable: true,
    },
    kill: {
      value: async (signal?: KillSignal) => {
        await shell.killExec({ id, signal });
        await exited;
      },
      enumerable: false,
      writable: false,
      configurable: true,
    },
  });
  return handle;
}

// Drain the watcher branch in the background, resolving once the
// first exit event is observed (or the stream closes / errors
// without one). Errors are swallowed so kill() doesn't reject on a
// torn-down wire — the caller's own branch will surface any real
// stream error.
function watchForExit(events: ReadableStream<ExecEvent>): Promise<void> {
  return (async () => {
    const reader = events.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        if (value.name === "exit") return;
      }
    } catch {
      // Swallow — surfaced via the user-facing branch instead.
    } finally {
      reader.releaseLock();
    }
  })();
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
  return source.pipeThrough(
    new TransformStream<ExecEvent, WorkspaceExecEvent<E>>({
      transform(event, controller) {
        if (event.name === "stdout") {
          controller.enqueue({
            id: event.id,
            seq: event.seq,
            name: "stdout",
            value: stdoutDec.decode(event.value, { stream: true }) as Chunk<E>,
          });
        } else if (event.name === "stderr") {
          controller.enqueue({
            id: event.id,
            seq: event.seq,
            name: "stderr",
            value: stderrDec.decode(event.value, { stream: true }) as Chunk<E>,
          });
        } else {
          controller.enqueue(event as WorkspaceExecEvent<E>);
        }
      },
      flush(_controller) {
        // Flush any trailing bytes the streaming decoder
        // held back. These are dropped on the floor today
        // — they'd land in an event with no seq attached.
        // In practice the child terminates its output with
        // a newline; partial multi-byte sequences at EOF
        // are rare. Note for follow-up if real callers see
        // truncation.
        stdoutDec.decode();
        stderrDec.decode();
      },
    }),
  );
}

async function drainToResult<E extends ExecEncoding>(
  stream: ReadableStream<WorkspaceExecEvent<E>>,
  encoding: E | undefined,
  sync: Sync,
  pushed: number,
): Promise<ExecResult<E>> {
  const reader = stream.getReader();
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
  }
  // Post-drain pull: apply anything computerd produced during the exec.
  // Failures non-fatal per docs/05 ("failed pushes/pulls do not
  // abort the command"); pulled / skipped stay at their empty
  // values in that case.
  let pulled = 0;
  let skipped: SkippedEntry[] = [];
  let syncResult: ExecSyncResult;
  try {
    const result = await sync.pull();
    pulled = result.applied;
    skipped = result.skipped;
    syncResult = { status: "complete", applied: pulled, skipped };
  } catch (error) {
    syncResult = { status: "pending", applied: 0, skipped: [], error: safeErrorMessage(error) };
    try {
      await sync.onPullPending?.(error);
    } catch {
      // The command result must remain available even when the host's
      // durable scheduler is temporarily unavailable. The pending
      // status keeps the missed pull visible to the caller.
    }
  }
  return {
    exitCode,
    stdout: joinParts<E>(stdoutParts, encoding),
    stderr: joinParts<E>(stderrParts, encoding),
    pushed,
    pulled,
    skipped,
    sync: syncResult,
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

// Pipe `stream` through an identity TransformStream that fires `onDone`
// exactly once when the stream finishes — clean end, cancel, or
// error. Used to release a capnweb result envelope as soon as the
// event stream it carried is drained, without having to keep the
// envelope reference alive across wrapHandle().
function disposeOnDone<T>(stream: ReadableStream<T>, onDone: () => void): ReadableStream<T> {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    try {
      onDone();
    } catch {
      // ignore — disposer errors are not actionable here
    }
  };
  return stream.pipeThrough(
    new TransformStream<T, T>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
      flush() {
        fire();
      },
      cancel() {
        fire();
      },
    }),
  );
}

// Best-effort dispose of a capnweb result envelope. Real envelopes
// expose [Symbol.dispose]; test fakes return plain objects, so the
// symbol may be absent.
function maybeDispose(value: unknown): void {
  const d = (value as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose];
  if (typeof d === "function") d.call(value);
}
