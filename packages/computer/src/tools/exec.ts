import { type Tool, tool } from "ai";
import { z } from "zod";

import { notCallableMessage } from "../runtime/runtime.js";
import type { WorkspaceRuntimeValue } from "../runtime/types.js";
import { truncateText, utf8Prefix } from "../text-truncation.js";

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
  | { name: "exit"; code: number; result?: unknown };

// A detached execution handle. The tool streams stdout / stderr
// chunks by iterating the handle when it is async-iterable, and
// falls back to draining result() when it is not.
export interface ExecRuntimeHandle extends Partial<AsyncIterable<ExecStreamEvent>> {
  result(): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    value?: unknown;
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
      },
    ): Promise<ExecRuntimeHandle>;
    // Whether a backend accepts a structured `input` value and returns
    // a structured result. The tool asks this to know which backends
    // are callable; the runtime derives it from each backend's
    // `callable` flag. Omit when no backend is callable.
    isCallable?(id: string): boolean;
    // What a backend says about itself for a model, such as the
    // language it runs and the modules that code can import. The tool
    // shows it after the caller's own description.
    describe?(id: string): string | undefined;
  };
}

export interface ExecBackendDescription {
  // Guidance for the model about this backend, shown before whatever
  // the backend says about itself. Required only when the backend does
  // not describe itself.
  description?: string;
}

export interface ExecToolOptions {
  workspace: ExecWorkspaceLike;
  // Backends the model may run on. With exactly one, the tool has no
  // `backend` argument and always runs there, so the model never has
  // to reason about backends.
  backends: Record<string, ExecBackendDescription>;
  // Backend used when the model omits `backend`. Required when more
  // than one backend is configured; with one it defaults to that one.
  defaultBackend?: string;
  // Per-snapshot display cap for each of stdout and stderr, in bytes.
  // Output past it is shown as a truncation marker. Defaults to 64 KiB.
  maxBytes?: number;
  // In-memory cap per stream while streaming, in bytes. Output past it
  // is counted toward the truncation marker but not retained, so a long
  // run does not grow the buffer without bound. Defaults to 512 KiB.
  streamMaxBytes?: number;
  // Clock backing the running-snapshot coalescing floor. Defaults to
  // Date.now; injectable so tests can drive the interval deterministically.
  now?: () => number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_STREAM_MAX_BYTES = 512 * 1024;
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
  | { command: string; cwd: string | null; backend: string; error: string };

type ExecToolInput = {
  command: string;
  cwd?: string;
  backend?: string;
  env?: Record<string, string>;
  input?: WorkspaceRuntimeValue;
};

export function createExecTool(options: ExecToolOptions): Tool<ExecToolInput, ExecToolOutput> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const streamMaxBytes = options.streamMaxBytes ?? DEFAULT_STREAM_MAX_BYTES;
  const now = options.now ?? Date.now;
  const backendIds = Object.keys(options.backends);
  if (backendIds.length === 0) {
    throw new Error("createExecTool: pass at least one backend in `backends`");
  }
  const single = backendIds.length === 1;
  const defaultBackend = options.defaultBackend ?? (single ? backendIds[0] : undefined);
  if (defaultBackend === undefined || !backendIds.includes(defaultBackend)) {
    throw new Error(
      `createExecTool: pass a defaultBackend that is one of ${backendIds.map((id) => JSON.stringify(id)).join(", ")}`,
    );
  }

  const runtime = options.workspace.runtime;
  const backends = backendIds.map((id) => {
    const text = [options.backends[id]?.description, runtime.describe?.(id)]
      .filter((part) => part !== undefined && part !== "")
      .join("\n\n");
    if (text === "") {
      throw new Error(
        `createExecTool: backend ${JSON.stringify(id)} does not describe itself; pass a description`,
      );
    }
    return { id, text, callable: runtime.isCallable?.(id) === true };
  });
  const callableBackendIds = new Set(backends.filter((b) => b.callable).map((b) => b.id));
  const description = describeTool(backends, defaultBackend);
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
      // SAFETY: createExecTool checked that backendIds has at least one entry.
      .enum(backendIds as [string, ...string[]])
      .optional()
      .describe(
        `Which backend to run on. Omit to use the default (${JSON.stringify(defaultBackend)}). If a command fails because the backend lacks that tool, retry on a backend whose description covers it.`,
      );
  }
  if (callableBackendIds.size > 0) {
    shape.input = jsonValueSchema
      .optional()
      .describe(
        single
          ? "Structured value handed to the module."
          : "Structured value handed to a callable backend's module. Other backends reject it.",
      );
  }
  // SAFETY: Every field in `shape` has the type ExecToolInput gives it, and the fields left out are optional there.
  const inputSchema = z.object(shape) as unknown as z.ZodType<ExecToolInput>;

  return tool({
    description,
    inputSchema,
    execute: async function* ({ command, cwd, backend, env, input }, { abortSignal }) {
      const selectedBackend = backend ?? defaultBackend;
      const base = { command, cwd: cwd ?? null, backend: selectedBackend };
      if (input !== undefined && !callableBackendIds.has(selectedBackend)) {
        yield { ...base, error: notCallableMessage(selectedBackend) };
        return;
      }
      let handle: ExecRuntimeHandle;
      try {
        handle = await options.workspace.runtime.exec(command, {
          cwd,
          encoding: "utf8",
          backend: selectedBackend,
          env,
          input,
        });
      } catch (err) {
        yield { ...base, error: errorMessage(err) };
        return;
      }

      // Aborting the model turn kills the backend execution so it does
      // not run on unobserved after the tool stops iterating. The run
      // then emits its terminal event and the stream closes normally.
      const onAbort = () => void handle.kill?.().catch(() => undefined);
      if (abortSignal?.aborted) onAbort();
      else abortSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        yield* runExecution();
      } finally {
        abortSignal?.removeEventListener("abort", onAbort);
      }

      // Produce the run's snapshots. Streams the raw events when the
      // handle is iterable; otherwise drains the aggregate result.
      async function* runExecution(): AsyncGenerator<ExecToolOutput> {
        // Stream stdout / stderr chunks as they arrive when the handle
        // is iterable. Each chunk yields a fresh snapshot with the
        // running output so the model sees progress before the run
        // ends; the exit event settles the terminal snapshot.
        if (typeof handle[Symbol.asyncIterator] === "function") {
          const stdout = new StreamBuffer(streamMaxBytes);
          const stderr = new StreamBuffer(streamMaxBytes);
          let exitCode: number | null = null;
          let value: unknown;
          let hasValue = false;
          // Coalesce running snapshots to at most one per interval. A
          // chatty command would otherwise yield a full-buffer snapshot
          // per chunk; the terminal snapshot below always fires.
          let lastSnapshot = 0;
          try {
            for await (const event of handle as AsyncIterable<ExecStreamEvent>) {
              if (event.name === "stdout") stdout.push(event.value);
              else if (event.name === "stderr") stderr.push(event.value);
              else {
                exitCode = event.code;
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
                stdout: stdout.render(maxBytes),
                stderr: stderr.render(maxBytes),
              };
            }
          } catch (err) {
            yield { ...base, error: errorMessage(err) };
            return;
          }
          yield {
            ...base,
            exitCode,
            stdout: stdout.render(maxBytes),
            stderr: stderr.render(maxBytes),
            ...(hasValue ? { result: value } : {}),
          };
          return;
        }

        // Non-streaming handle: drain the aggregate result.
        try {
          const result = await handle.result();
          yield {
            ...base,
            exitCode: result.exitCode,
            stdout: truncateText(result.stdout, maxBytes),
            stderr: truncateText(result.stderr, maxBytes),
            ...(result.value === undefined ? {} : { result: result.value }),
          };
        } catch (err) {
          yield { ...base, error: errorMessage(err) };
        }
      }
    },
  });
}

const FILE_TOOLS_HINT =
  "Prefer the dedicated read, write, and edit tools for file operations. Long output is truncated to keep tool replies small.";
const SHELL_HINT = "Use for builds, test runs, typechecks, formatters, and git plumbing.";
const CALLABLE_HINT =
  "Pass `input` to hand the module a structured value, and read its return value back from the `result` field.";

interface DescribedBackend {
  readonly id: string;
  readonly text: string;
  readonly callable: boolean;
}

// With one backend the description is about what it does. With several
// it lists them and explains how to choose.
function describeTool(backends: readonly DescribedBackend[], defaultBackend: string): string {
  const [only, ...others] = backends;
  if (only !== undefined && others.length === 0) {
    return only.callable
      ? ["Run code in the workspace.", "", only.text, "", CALLABLE_HINT, FILE_TOOLS_HINT].join("\n")
      : [
          "Run a shell command in the workspace.",
          "",
          only.text,
          "",
          `${SHELL_HINT} ${FILE_TOOLS_HINT}`,
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
    `Default backend: ${JSON.stringify(defaultBackend)}. Try this first for any command you're not sure about; if it fails with a "command not found" or a similar capability error, retry on a backend whose description covers the missing tool.`,
    `${SHELL_HINT} ${FILE_TOOLS_HINT}`,
    ...(callable.length === 0
      ? []
      : [
          "",
          `Callable backends (${callable.join(", ")}) run \`command\` as module source rather than a shell command. ${CALLABLE_HINT} Other backends reject \`input\`.`,
        ]),
  ].join("\n");
}

function commandHint(backends: readonly DescribedBackend[]): string {
  if (backends.every((backend) => backend.callable)) return "Module source to run.";
  if (backends.every((backend) => !backend.callable)) {
    return "Shell command, e.g. 'npm test' or 'git diff HEAD'.";
  }
  return "Shell command, e.g. 'npm test' or 'git diff HEAD'. For a callable backend this is the module source to run.";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const encoder = new TextEncoder();

// A bounded, incrementally-counted accumulator for one output stream.
// It keeps at most `cap` bytes of head text in memory while tracking
// the total bytes seen, so a long run neither grows without bound nor
// re-encodes the whole buffer on every snapshot. `render` returns the
// display-capped view with a marker for the bytes not shown.
class StreamBuffer {
  #head = "";
  #headBytes = 0;
  #totalBytes = 0;
  readonly #cap: number;

  constructor(cap: number) {
    this.#cap = cap;
  }

  push(chunk: string): void {
    const chunkBytes = encoder.encode(chunk).byteLength;
    this.#totalBytes += chunkBytes;
    if (this.#headBytes >= this.#cap) return;
    if (this.#headBytes + chunkBytes <= this.#cap) {
      this.#head += chunk;
      this.#headBytes += chunkBytes;
      return;
    }
    // The chunk crosses the cap: keep the largest whole-character
    // prefix that fits, then stop growing the head.
    const prefix = utf8Prefix(chunk, this.#cap - this.#headBytes);
    this.#head += prefix.text;
    this.#headBytes += prefix.bytes;
  }

  render(maxBytes: number): string {
    if (this.#totalBytes <= maxBytes && this.#totalBytes === this.#headBytes) {
      return this.#head;
    }
    const shown = utf8Prefix(this.#head, maxBytes);
    return `${shown.text}\n\n[truncated, ${this.#totalBytes - shown.bytes} more bytes]`;
  }
}
