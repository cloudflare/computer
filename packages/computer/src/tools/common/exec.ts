import { z } from "zod";
import type { TruncatedOutput } from "../../runtime/output-spool";
import {
  DEFAULT_OUTPUT_MAX_BYTES,
  DEFAULT_OUTPUT_MAX_LINES,
  makeOutputLimits,
  type OutputLimits,
  OutputWindow,
} from "../../runtime/output-tail";
import type { WorkspaceBackendInfo } from "../../runtime/runtime";
import { notCallableMessage } from "../../runtime/runtime";
import type { WorkspaceRuntimeTruncation, WorkspaceRuntimeValue } from "../../runtime/types";

// A finite JSON value: what a callable backend accepts as `input` and
// returns as `result`. Declared as a concrete recursive schema rather
// than z.unknown() so the tool validates `input` at its own boundary
// and the generated JSON Schema describes a real shape (z.unknown()
// serializes to an empty schema that some providers reject under
// strict function calling).
const jsonValueSchema: z.ZodType<WorkspaceRuntimeValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

// One event drained from a running execution. stdout / stderr carry
// output chunks as they arrive; exit carries the process exit code and,
// for a callable backend, the structured return value on `result`. The
// value settles at the same instant as the exit code, so it rides the
// same terminal event rather than a separate one.
export type ExecStreamEvent =
  | { name: "stdout"; value: string }
  | { name: "stderr"; value: string }
  | { name: "exit"; code: number; result?: unknown; truncated?: WorkspaceRuntimeTruncation };

// A detached execution handle. The tool streams stdout / stderr
// chunks by iterating the handle when it is async-iterable, and
// falls back to draining result() when it is not.
export interface ExecRuntimeHandle extends Partial<AsyncIterable<ExecStreamEvent>> {
  // The execution's id. A detached run reports it, and `pending()`
  // lists the run's waiting calls under it.
  readonly id?: string;
  result(): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    value?: unknown;
    truncated?: WorkspaceRuntimeTruncation;
  }>;
  // Signal the running execution. The tool calls it when the model
  // turn aborts, so the backend stops rather than running on after
  // the tool stops iterating.
  kill?(): Promise<void>;
}

export interface ExecWorkspaceLike {
  runtime: {
    exec(
      command: string,
      options: {
        cwd?: string;
        encoding: "utf8";
        backend?: string;
        env?: Record<string, string>;
        input?: WorkspaceRuntimeValue;
        metadata?: Record<string, string>;
        output?: { maxBytes: number; maxLines: number };
      },
    ): Promise<ExecRuntimeHandle>;
    // Calls waiting in ctx.interrupt(), by execution id, and noting
    // that nothing waits on a run any more. Needed to detach.
    pending?(): Promise<
      ReadonlyArray<{ readonly id: string; readonly callId: string; readonly payload: unknown }>
    >;
    detachExec?(id: string, options?: { backend?: string }): Promise<boolean>;
    // What each registered backend says about itself: whether it takes
    // structured `input`, and its description for the model. Used to
    // build the tool, to offer every backend when the caller picks none,
    // and to reject an unknown id up front. Without it, every backend
    // must be named and is treated as a shell.
    backends?(): readonly WorkspaceBackendInfo[];
  };
}

/** Options for one backend the exec tool may run on. */
export interface ExecBackendOptions {
  /** Shown to the model before the backend's own description. */
  readonly description?: string;
}

/**
 * The backends the exec tool may run on, keyed by backend id:
 * `{ codemode: { description: "Use for data work." } }`.
 * Pass `{}` for a backend that needs nothing beyond its own
 * description.
 */
export type ExecBackends = Readonly<Record<string, ExecBackendOptions>>;

/**
 * The `metadata` each exec run starts with, for host modules; the model
 * never sees it. A function picks it per tool call. A throw fails the
 * call without running it.
 */
export type ExecMetadata =
  | Record<string, string>
  | ((call: { toolCallId: string }) => Record<string, string>);

/**
 * Whether the exec tool may return before a run ends, leaving it
 * running. `true` detaches a run once it waits for an answer in
 * `ctx.interrupt()`, such as for an approval. `{ afterMs }` also
 * detaches a run that is still going after that many milliseconds.
 * Experimental: it may change in any release.
 */
export type ExecDetachOptions = true | { readonly afterMs?: number };

export interface ExecToolOptions {
  workspace: ExecWorkspaceLike;
  // Omit to offer every backend the Workspace has. With one backend
  // the tool has no `backend` argument; with several the model must
  // name one on every call.
  backends?: ExecBackends;
  // The most bytes of each of stdout and stderr the model sees.
  // Longer output keeps its last lines, like pi's bash tool, and the
  // runtime saves the full output to a file the reply names. Defaults
  // to 64 KiB.
  maxBytes?: number;
  // The most lines of each stream the model sees. Defaults to 2000.
  maxLines?: number;
  /**
   * @deprecated Ignored. Memory per stream is now bounded by a few
   * times `maxBytes`.
   */
  streamMaxBytes?: number;
  /**
   * Each run's `metadata`, such as the conversation the tool call
   * belongs to. Metadata a call passes itself, as a pi caller can, wins.
   */
  metadata?: ExecMetadata;
  /**
   * Return before a run ends, and leave it running, so the agent can
   * carry on. The reply has the run's `executionId`, a `status` of
   * `"waiting"` or `"running"`, and its output so far. Aborting the
   * model turn doesn't kill a run once it has detached. The run's exit
   * goes to its backend's `onDetachedExit`, which tells the agent. Needs
   * a backend that can detach, such as a `CodemodeBackend` with
   * `onDetachedExit`.
   */
  detach?: ExecDetachOptions;
  // Clock backing the running-snapshot coalescing floor. Defaults to
  // Date.now; injectable so tests can drive the interval deterministically.
  now?: () => number;
}

// Minimum wall-clock gap between running snapshots. A chatty command
// yields at most one snapshot per interval instead of one per chunk;
// the terminal snapshot always fires regardless.
const STREAM_COALESCE_MS = 100;

// Progressive snapshot emitted while a command streams (exitCode
// null until the run ends), and the terminal snapshot once the exit
// code lands. `result` appears only when a callable backend returned
// a value; `error` replaces the run fields when the exec fails.
export type ExecToolOutput =
  | {
      command: string;
      cwd: string | null;
      backend: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      result?: unknown;
    }
  | {
      command: string;
      cwd: string | null;
      backend: string;
      // The run is still going: it detached, as `ExecToolOptions.detach` asked.
      executionId: string;
      status: "waiting" | "running";
      stdout: string;
      stderr: string;
      // The calls waiting for an answer, when the run is waiting.
      waiting?: Array<{ callId: string; payload: unknown }>;
      note: string;
    }
  | { command: string; cwd: string | null; backend: string; error: string };

export interface ExecInput {
  command: string;
  cwd?: string;
  backend?: string;
  env?: Record<string, string>;
  input?: { [key: string]: WorkspaceRuntimeValue };
}

export interface ExecCallContext {
  abortSignal?: AbortSignal;
  /** The tool call's id, handed to an `ExecToolOptions.metadata` function. */
  toolCallId?: string;
  /** The run's metadata. When set, `ExecToolOptions.metadata` isn't used. */
  metadata?: Record<string, string>;
}

/** The exec tool with no agent library attached. Each library wraps it in its own tool shape. */
export interface ExecDefinition {
  description: string;
  inputSchema: z.ZodType<ExecInput>;
  prepareArguments(args: unknown): unknown;
  /**
   * Yields running snapshots while the command streams, then one
   * terminal snapshot. Every snapshot is a complete result, so a
   * library that cannot stream tool output keeps the last one.
   */
  execute(input: ExecInput, context?: ExecCallContext): AsyncGenerator<ExecToolOutput>;
}

/**
 * Resolve the backends once and build the exec tool's description,
 * input schema, and executor. Throws when no backend is left or an id
 * is unknown, so a misconfigured tool fails when it is built.
 */
export function defineExec(options: ExecToolOptions): ExecDefinition {
  const limits = makeOutputLimits(
    {
      maxBytes: options.maxBytes ?? DEFAULT_OUTPUT_MAX_BYTES,
      maxLines: options.maxLines ?? DEFAULT_OUTPUT_MAX_LINES,
    },
    "createExecTool",
  );
  const now = options.now ?? Date.now;
  const runtime = options.workspace.runtime;
  const detach = options.detach;
  const afterMs = typeof detach === "object" ? detach.afterMs : undefined;
  if (afterMs !== undefined && (!Number.isFinite(afterMs) || afterMs < 0)) {
    throw new Error("createExecTool: detach.afterMs must be a finite number of milliseconds");
  }
  // Read the backends once, so selection and descriptions agree.
  const known = runtime.backends?.();
  const selected = selectBackends(options.backends, known);
  const [first] = selected;
  if (first === undefined) throw new Error("createExecTool: no backends to run on");
  const backendIds = selected.map((backend) => backend.id);
  const single = backendIds.length === 1;
  const backends = selected.map(({ id, guidance }) => {
    const info = known?.find((backend) => backend.id === id);
    const callable = info?.callable === true;
    const own = info?.description;
    const text =
      [guidance, own].filter((part) => part !== undefined && part !== "").join("\n\n") ||
      (callable ? "Runs `command` as module source." : "Runs shell commands.");
    return { id, text, callable, detachable: info?.detachable === true };
  });
  const callableBackendIds = new Set(backends.filter((b) => b.callable).map((b) => b.id));
  // Only runs on a backend that can detach do: their exit goes to the
  // backend's `onDetachedExit`. Runs elsewhere stay attached.
  const detachable = new Set(
    detach === undefined ? [] : backends.filter((b) => b.detachable).map((b) => b.id),
  );
  const detachExec = runtime.detachExec;
  const pending = runtime.pending;
  if (detach !== undefined) {
    if (detachExec === undefined || pending === undefined) {
      throw new Error("createExecTool: detach needs a runtime with detachExec() and pending()");
    }
    if (detachable.size === 0) {
      throw new Error(
        "createExecTool: detach needs a backend that can detach, such as a CodemodeBackend with onDetachedExit",
      );
    }
  }
  const description = [
    describeTool(backends, limits),
    detach === undefined
      ? ""
      : detachHint(afterMs, detachable.size === backends.length ? undefined : [...detachable]),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  // Offer only the fields that can work: `backend` when there is a
  // choice, `input` when some backend accepts it.
  const shape: Record<string, z.ZodType> = {
    command: z.string().describe(commandHint(backends)),
    cwd: z.string().optional().describe("Working directory. Defaults to the workspace root."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Environment variables for this run only. Values override the base environment without affecting later runs.",
      ),
  };
  if (!single) {
    shape.backend = z
      // SAFETY: defineExec checked that backendIds has at least one entry.
      .enum(backendIds as [string, ...string[]])
      .describe(
        "Which backend to run on. If a command fails because the backend lacks that tool, retry on a backend whose description covers it.",
      );
  }
  if (callableBackendIds.size > 0) {
    shape.input = z
      .record(z.string(), jsonValueSchema)
      .optional()
      .describe(
        single
          ? "Input object handed to the module."
          : "Input object handed to a callable backend's module. Other backends reject it.",
      );
  }
  // SAFETY: Every field in `shape` has the type ExecInput gives it, and the fields left out are optional there.
  const inputSchema = z.object(shape) as unknown as z.ZodType<ExecInput>;

  // Settles when the run should detach, as `detach` asks, and never
  // otherwise. Stop it once the tool is done with the run. The run is
  // marked detached before this settles; if it ended first, this never
  // settles and the tool reads its result as usual.
  function watchDetach(
    handle: ExecRuntimeHandle,
    backend: string,
  ): {
    promise: Promise<DetachReason>;
    // Before the tool returns a result: whether a detach already under
    // way went through. If it did, the run's exit goes to the Workspace,
    // so the tool must reply as detached rather than with the result.
    settle(): Promise<DetachReason | undefined>;
    stop(): void;
  } {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let stopped = false;
    let inFlight: Promise<DetachReason | undefined> | undefined;
    const promise = new Promise<DetachReason>((resolve) => {
      const id = handle.id;
      if (!detachable.has(backend) || id === undefined) return;
      if (detachExec === undefined || pending === undefined) return;
      // Detach once, if the run hasn't ended. A run that can't detach
      // stays attached rather than losing its result.
      const tryDetach = async (reason: DetachReason) => {
        if (inFlight !== undefined || stopped) return;
        inFlight = detachExec
          .call(runtime, id, { backend })
          .catch((error: unknown) => {
            console.error({ message: "exec: detach failed", id, error: String(error) });
            return false;
          })
          .then((detached) => (detached ? reason : undefined));
        const detached = await inFlight;
        if (detached !== undefined) resolve(detached);
        else stop();
      };
      if (afterMs !== undefined) {
        timers.push(setTimeout(() => void tryDetach({ status: "running" }), afterMs));
      }
      const poll = async () => {
        if (stopped || inFlight !== undefined) return;
        const waiting = await pending.call(runtime).catch(() => []);
        const own = waiting.filter((call) => call.id === id);
        if (own.length > 0) {
          await tryDetach({
            status: "waiting",
            waiting: own.map((call) => ({ callId: call.callId, payload: call.payload })),
          });
          return;
        }
        if (!stopped) timers.push(setTimeout(() => void poll(), WAIT_POLL_MS));
      };
      void poll();
    });
    function stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
    }
    return {
      promise,
      async settle() {
        const reason = await inFlight;
        stop();
        return reason;
      },
      stop,
    };
  }

  return {
    description,
    inputSchema,
    prepareArguments: callableBackendIds.size > 0 ? parseInputObject : (args) => args,
    execute: async function* ({ command, cwd, backend, env, input }, context = {}) {
      const { abortSignal } = context;
      // With one backend there is nothing to choose. With several the
      // schema requires `backend`; a caller that skips the schema gets
      // the same answer as an error.
      const selectedBackend = single ? first.id : backend;
      if (selectedBackend === undefined) {
        yield { command, cwd: cwd ?? null, backend: "", error: "Name a backend to run on." };
        return;
      }
      const base = { command, cwd: cwd ?? null, backend: selectedBackend };
      if (input !== undefined && !callableBackendIds.has(selectedBackend)) {
        yield { ...base, error: notCallableMessage(selectedBackend) };
        return;
      }
      let handle: ExecRuntimeHandle;
      try {
        const metadata =
          context.metadata ??
          (typeof options.metadata === "function"
            ? options.metadata({ toolCallId: context.toolCallId ?? "" })
            : options.metadata);
        handle = await options.workspace.runtime.exec(command, {
          cwd,
          encoding: "utf8",
          backend: selectedBackend,
          env,
          input,
          ...(metadata === undefined ? {} : { metadata }),
          // The runtime cuts and saves by the same limits the tool
          // shows, so whatever the model does not see is in the file.
          output: limits,
        });
      } catch (err) {
        yield { ...base, error: errorMessage(err) };
        return;
      }

      // Aborting the model turn kills the backend execution so it does
      // not run on unobserved after the tool stops iterating. The run
      // then emits its terminal event and the stream closes normally.
      // A run that detached is meant to run on, so it's left alone.
      const onAbort = () => void handle.kill?.().catch(() => undefined);
      if (abortSignal?.aborted) onAbort();
      else abortSignal?.addEventListener("abort", onAbort, { once: true });
      const detaching = watchDetach(handle, selectedBackend);
      try {
        yield* runExecution();
      } finally {
        detaching.stop();
        abortSignal?.removeEventListener("abort", onAbort);
      }

      // The snapshot of a run that detached, which carries on without the tool.
      function detached(reason: DetachReason, stdout: string, stderr: string): ExecToolOutput {
        return {
          ...base,
          executionId: handle.id ?? "",
          status: reason.status,
          stdout,
          stderr,
          ...(reason.status === "waiting" ? { waiting: reason.waiting } : {}),
          note:
            reason.status === "waiting"
              ? "The run is still going. It is waiting for an answer to the calls in `waiting`, and carries on by itself once they are answered. Don't run it again: you'll get a message with its outcome when it ends."
              : "The run is still going in the background. Don't run it again: you'll get a message with its outcome when it ends.",
        };
      }

      // Produce the run's snapshots. Streams the raw events when the
      // handle is iterable; otherwise drains the aggregate result.
      async function* runExecution(): AsyncGenerator<ExecToolOutput> {
        // Stream stdout / stderr chunks as they arrive when the handle
        // is iterable. Each chunk yields a fresh snapshot with the
        // running output so the model sees progress before the run
        // ends; the exit event settles the terminal snapshot.
        if (typeof handle[Symbol.asyncIterator] === "function") {
          const stdout = new OutputText(limits);
          const stderr = new OutputText(limits);
          let truncated: WorkspaceRuntimeTruncation | undefined;
          let exitCode: number | null = null;
          let value: unknown;
          let hasValue = false;
          // Coalesce running snapshots to at most one per interval. A
          // chatty command would otherwise yield a full-buffer snapshot
          // per chunk; the terminal snapshot below always fires.
          let lastSnapshot = 0;
          const iterator = (handle as AsyncIterable<ExecStreamEvent>)[Symbol.asyncIterator]();
          try {
            while (true) {
              const next = iterator.next();
              const step = await Promise.race([
                next.then((value) => ({ kind: "event" as const, value })),
                detaching.promise.then((reason) => ({ kind: "detach" as const, reason })),
              ]);
              if (step.kind === "detach") {
                // Stop listening without stopping the run. The read in
                // flight settles whenever the run next prints or ends.
                next.catch(() => undefined);
                void iterator.return?.()?.catch(() => undefined);
                abortSignal?.removeEventListener("abort", onAbort);
                yield detached(step.reason, stdout.render(), stderr.render());
                return;
              }
              if (step.value.done === true) break;
              const event = step.value.value;
              if (event.name === "stdout") stdout.push(event.value);
              else if (event.name === "stderr") stderr.push(event.value);
              else {
                exitCode = event.code;
                truncated = event.truncated;
                if ("result" in event) {
                  value = event.result;
                  hasValue = true;
                }
                continue;
              }
              const at = now();
              if (at - lastSnapshot < STREAM_COALESCE_MS) continue;
              lastSnapshot = at;
              yield {
                ...base,
                exitCode: null,
                stdout: stdout.render(),
                stderr: stderr.render(),
              };
            }
          } catch (err) {
            yield { ...base, error: errorMessage(err) };
            return;
          }
          const late = await detaching.settle();
          if (late !== undefined) {
            abortSignal?.removeEventListener("abort", onAbort);
            yield detached(late, stdout.render(), stderr.render());
            return;
          }
          yield {
            ...base,
            exitCode,
            stdout: stdout.render(truncated?.stdout ?? "unsaved"),
            stderr: stderr.render(truncated?.stderr ?? "unsaved"),
            ...(hasValue ? { result: value } : {}),
          };
          return;
        }

        // Non-streaming handle: drain the aggregate result.
        try {
          const settled = handle.result();
          const step = await Promise.race([
            settled.then((value) => ({ kind: "result" as const, value })),
            detaching.promise.then((reason) => ({ kind: "detach" as const, reason })),
          ]);
          if (step.kind === "detach") {
            settled.catch(() => undefined);
            abortSignal?.removeEventListener("abort", onAbort);
            yield detached(step.reason, "", "");
            return;
          }
          const result = step.value;
          const late = await detaching.settle();
          if (late !== undefined) {
            yield detached(late, "", "");
            return;
          }
          yield {
            ...base,
            exitCode: result.exitCode,
            stdout: showResult(result.stdout, result.truncated?.stdout, limits),
            stderr: showResult(result.stderr, result.truncated?.stderr, limits),
            ...(result.value === undefined ? {} : { result: result.value }),
          };
        } catch (err) {
          yield { ...base, error: errorMessage(err) };
        }
      }
    },
  };
}

// How often a run that may detach on a wait checks for one.
const WAIT_POLL_MS = 250;

type DetachReason =
  | { status: "running" }
  | { status: "waiting"; waiting: Array<{ callId: string; payload: unknown }> };

function detachHint(
  afterMs: number | undefined,
  // The backends whose runs detach, when not every one does.
  only: readonly string[] | undefined,
): string {
  const when = [
    "waits for an answer, such as an approval",
    ...(afterMs === undefined
      ? []
      : [`is still going after ${Math.round(afterMs / 1000)} seconds`]),
  ];
  const where =
    only === undefined ? "" : ` on ${only.map((id) => JSON.stringify(id)).join(" or ")}`;
  return `A run${where} that ${when.join(" or ")} comes back early with its \`executionId\`, a \`status\` of "waiting" or "running", and its output so far, and keeps going on its own. Tell the user what is happening and carry on; don't run it again. Its outcome arrives in a later message.`;
}

const FILE_TOOLS_HINT = "Prefer the dedicated read, write, and edit tools for file operations.";

// How the reply cuts long output, and where the rest goes.
function outputHint(limits: OutputLimits): string {
  return `Each of stdout and stderr is cut to its last ${limits.maxLines} lines or ${formatSize(limits.maxBytes)}, whichever is hit first; when it is, the full output is saved to a file the reply names, which the read and grep tools can open.`;
}
const SHELL_HINT = "Use for builds, test runs, typechecks, formatters, and git plumbing.";
const CALLABLE_HINT =
  "Pass an `input` object to hand the module structured values, and read its return value back from the `result` field.";

interface DescribedBackend {
  readonly id: string;
  readonly text: string;
  readonly callable: boolean;
}

// With one backend the description is about what it does. With several
// it lists them and explains how to choose.
function describeTool(backends: readonly DescribedBackend[], limits: OutputLimits): string {
  const output = outputHint(limits);
  const [only, ...others] = backends;
  if (only !== undefined && others.length === 0) {
    return only.callable
      ? [
          "Run code in the workspace.",
          "",
          only.text,
          "",
          CALLABLE_HINT,
          `${FILE_TOOLS_HINT} ${output}`,
        ].join("\n")
      : [
          "Run a shell command in the workspace.",
          "",
          only.text,
          "",
          `${SHELL_HINT} ${FILE_TOOLS_HINT} ${output}`,
        ].join("\n");
  }
  const callable = backends.filter((backend) => backend.callable).map((b) => JSON.stringify(b.id));
  return [
    "Run a shell command in the workspace. The workspace exposes multiple backends, each with different capabilities.",
    "Pick the cheapest backend that can run the command; fall back to a heavier one only when the lighter backend's command set doesn't cover what you need.",
    "",
    "Backends:",
    ...backends.map(
      (b) => `- ${JSON.stringify(b.id)}${b.callable ? " (callable)" : ""}: ${b.text}`,
    ),
    "",
    'Name a backend on every call. If a command fails with a "command not found" or a similar capability error, retry on a backend whose description covers the missing tool.',
    `${SHELL_HINT} ${FILE_TOOLS_HINT} ${output}`,
    ...(callable.length === 0
      ? []
      : [
          "",
          `Callable backends (${callable.join(", ")}) run \`command\` as module source rather than a shell command. ${CALLABLE_HINT} Other backends reject \`input\`.`,
        ]),
  ].join("\n");
}

// Resolve the caller's choice to a list of backends.
function selectBackends(
  backends: ExecBackends | undefined,
  registered: readonly WorkspaceBackendInfo[] | undefined,
): Array<{ id: string; guidance: string | undefined }> {
  const known = registered?.map((backend) => backend.id);
  let selected: Array<{ id: string; guidance: string | undefined }>;
  if (backends === undefined) {
    if (known === undefined) {
      throw new Error("createExecTool: pass `backends`; this workspace cannot list its backends");
    }
    selected = known.map((id) => ({ id, guidance: undefined }));
  } else {
    selected = Object.entries(backends).map(([id, backend]) => ({
      id,
      guidance: backend.description,
    }));
  }
  const unknown = known === undefined ? [] : selected.filter((b) => !known.includes(b.id));
  if (unknown.length > 0) {
    throw new Error(
      `createExecTool: unknown backend ${unknown.map((b) => JSON.stringify(b.id)).join(", ")}; the workspace has ${known?.map((id) => JSON.stringify(id)).join(", ") || "none"}`,
    );
  }
  return selected;
}

function commandHint(backends: readonly DescribedBackend[]): string {
  if (backends.every((backend) => backend.callable)) return "Module source to run.";
  if (backends.every((backend) => !backend.callable)) {
    return "Shell command, e.g. 'npm test' or 'git diff HEAD'.";
  }
  return "Shell command, e.g. 'npm test' or 'git diff HEAD'. For a callable backend this is the module source to run.";
}

function parseInputObject(args: unknown): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  const input = (args as { input?: unknown }).input;
  if (typeof input !== "string" || !input.trimStart().startsWith("{")) return args;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return args;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return args;
  return { ...args, input: parsed };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// One stream of streamed output as the model sees it: everything while
// it fits the limits, then its last lines with a note saying which
// lines are shown and where the rest is. Memory stays bounded however
// long the run.
class OutputText {
  readonly #window: OutputWindow;
  readonly #limits: OutputLimits;

  constructor(limits: OutputLimits) {
    this.#window = new OutputWindow(limits);
    this.#limits = limits;
  }

  push(chunk: string): void {
    this.#window.push(encoder.encode(chunk));
  }

  // Running snapshots pass nothing; the terminal one passes what the
  // runtime said about saving, or "unsaved" when it saved nothing.
  render(saved?: TruncatedOutput | "unsaved"): string {
    const kept = this.#window.read();
    const text = decoder.decode(kept.bytes);
    if (kept._tag === "whole" || saved === undefined) return text;
    return `${text}${note(
      {
        firstLine: kept.firstLine,
        lastLine: kept.lastLine,
        totalLines: this.#window.totalLines,
        partialLine: kept.partialLine,
        shownBytes: kept.bytes.length,
      },
      saved === "unsaved" ? undefined : saved,
      this.#limits,
    )}`;
  }
}

// A result's output as the model sees it. A runtime that cut it says
// so on `truncated`; output from a runtime that does not cut is cut
// here, without a file to point to.
function showResult(
  value: string,
  truncated: TruncatedOutput | undefined,
  limits: OutputLimits,
): string {
  if (truncated !== undefined) {
    return `${value}${note(
      {
        firstLine: truncated.firstLine,
        lastLine: truncated.totalLines,
        totalLines: truncated.totalLines,
        partialLine: truncated.partialLine,
        shownBytes: encoder.encode(value).length,
      },
      truncated,
      limits,
    )}`;
  }
  const text = new OutputText(limits);
  text.push(value);
  return text.render("unsaved");
}

interface ShownLines {
  readonly firstLine: number;
  readonly lastLine: number;
  readonly totalLines: number;
  readonly partialLine: boolean;
  readonly shownBytes: number;
}

// The note after cut output, worded as pi words it.
function note(shown: ShownLines, saved: TruncatedOutput | undefined, limits: OutputLimits): string {
  const where =
    saved === undefined
      ? ""
      : saved.status === "saved"
        ? ` Full output: ${saved.path}`
        : ` Full output was not saved: ${saved.reason}`;
  if (shown.partialLine) {
    return `\n\n[Showing last ${formatSize(shown.shownBytes)} of line ${shown.lastLine}.${where}]`;
  }
  const range = `lines ${shown.firstLine}-${shown.lastLine} of ${shown.totalLines}`;
  const byLines = shown.lastLine - shown.firstLine + 1 >= limits.maxLines;
  const limit = byLines ? "" : ` (${formatSize(limits.maxBytes)} limit)`;
  return `\n\n[Showing ${range}${limit}.${where}]`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
