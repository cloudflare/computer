import { type Tool, tool } from "ai";
import { z } from "zod";

import type { WorkspaceRuntimeValue } from "../runtime/types.js";

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
  };
}

export interface ExecBackendDescription {
  description: string;
}

export interface ExecToolOptions {
  workspace: ExecWorkspaceLike;
  backends: Record<string, ExecBackendDescription>;
  defaultBackend: string;
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

export function createExecTool(options: ExecToolOptions): Tool<
  {
    command: string;
    cwd?: string;
    backend?: string;
    env?: Record<string, string>;
    input?: unknown;
  },
  ExecToolOutput
> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const streamMaxBytes = options.streamMaxBytes ?? DEFAULT_STREAM_MAX_BYTES;
  const now = options.now ?? Date.now;
  const backendIds = Object.keys(options.backends);
  if (backendIds.length === 0) {
    throw new Error("createExecTool: pass at least one backend in `backends`");
  }
  if (!backendIds.includes(options.defaultBackend)) {
    throw new Error(
      `createExecTool: defaultBackend ${JSON.stringify(options.defaultBackend)} is not one of ${backendIds.map((id) => JSON.stringify(id)).join(", ")}`,
    );
  }

  const isCallable = options.workspace.runtime.isCallable?.bind(options.workspace.runtime);
  const callableBackendIds = new Set(backendIds.filter((id) => isCallable?.(id) === true));
  const backendGuidance = backendIds
    .map((id) => {
      const suffix = callableBackendIds.has(id) ? " (callable)" : "";
      return `- ${JSON.stringify(id)}${suffix}: ${options.backends[id].description}`;
    })
    .join("\n");
  const callableGuidance =
    callableBackendIds.size > 0
      ? [
          "",
          `Callable backends (${[...callableBackendIds].map((id) => JSON.stringify(id)).join(", ")}) run \`command\` as module source rather than a shell command. Pass \`input\` to hand the module a structured value, and read the module's returned value back from the \`result\` field. Other backends reject \`input\`.`,
        ].join("\n")
      : "";
  const description = [
    "Run a shell command in the workspace. The workspace exposes multiple backends, each with different capabilities.",
    "Pick the cheapest backend that can run the command; fall back to a heavier one only when the lighter backend's command set doesn't cover what you need.",
    "",
    "Backends:",
    backendGuidance,
    "",
    `Default backend: ${JSON.stringify(options.defaultBackend)}. Try this first for any command you're not sure about; if it fails with a "command not found" or a similar capability error, retry on a backend whose description covers the missing tool.`,
    "Use for builds, test runs, typechecks, formatters, and git plumbing. Prefer the dedicated read, write, and edit tools for file operations. Long output is truncated to keep tool replies small.",
    callableGuidance,
  ].join("\n");

  const backendSchema = z
    .enum(backendIds as [string, ...string[]])
    .optional()
    .describe(
      [
        "Which backend to run on. Omit to use the default",
        `(${JSON.stringify(options.defaultBackend)}). Set explicitly when the`,
        "default backend is not capable of running the command. If a command fails because the backend lacks that tool, retry on a backend whose description covers it.",
      ].join(" "),
    );

  return tool({
    description,
    inputSchema: z.object({
      command: z
        .string()
        .describe(
          "Shell command, e.g. 'npm test' or 'git diff HEAD'. For a callable backend this is the module source to run.",
        ),
      cwd: z.string().optional().describe("Working directory. Defaults to the workspace root."),
      backend: backendSchema,
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Environment variables for this run only. Values override the backend's base environment without affecting later runs.",
        ),
      input: z
        .unknown()
        .optional()
        .describe(
          "Structured value handed to a callable backend's module. Only callable backends accept it; other backends reject it.",
        ),
    }),
    execute: async function* ({ command, cwd, backend, env, input }) {
      const selectedBackend = backend ?? options.defaultBackend;
      const base = { command, cwd: cwd ?? null, backend: selectedBackend };
      if (input !== undefined && !callableBackendIds.has(selectedBackend)) {
        yield {
          ...base,
          error: `Backend ${JSON.stringify(selectedBackend)} is not callable; it does not accept structured input.`,
        };
        return;
      }
      let handle: ExecRuntimeHandle;
      try {
        handle = await options.workspace.runtime.exec(command, {
          cwd,
          encoding: "utf8",
          backend: selectedBackend,
          env,
          input: input as WorkspaceRuntimeValue,
        });
      } catch (err) {
        yield { ...base, error: errorMessage(err) };
        return;
      }

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
          stdout: truncate(result.stdout, maxBytes),
          stderr: truncate(result.stderr, maxBytes),
          ...(result.value === undefined ? {} : { result: result.value }),
        };
      } catch (err) {
        yield { ...base, error: errorMessage(err) };
      }
    },
  });
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
    let used = this.#headBytes;
    let end = 0;
    for (const char of chunk) {
      const charBytes = encoder.encode(char).byteLength;
      if (used + charBytes > this.#cap) break;
      used += charBytes;
      end += char.length;
    }
    this.#head += chunk.slice(0, end);
    this.#headBytes = used;
  }

  render(maxBytes: number): string {
    if (this.#totalBytes <= maxBytes && this.#totalBytes === this.#headBytes) {
      return this.#head;
    }
    let used = 0;
    let end = 0;
    for (const char of this.#head) {
      const charBytes = encoder.encode(char).byteLength;
      if (used + charBytes > maxBytes) break;
      used += charBytes;
      end += char.length;
    }
    return `${this.#head.slice(0, end)}\n\n[truncated, ${this.#totalBytes - used} more bytes]`;
  }
}

function truncate(value: string, maxBytes: number): string {
  if (!value) return value;
  const totalBytes = encoder.encode(value).byteLength;
  if (totalBytes <= maxBytes) return value;

  let usedBytes = 0;
  let endOffset = 0;
  for (const char of value) {
    const charBytes = encoder.encode(char).byteLength;
    if (usedBytes + charBytes > maxBytes) break;
    usedBytes += charBytes;
    endOffset += char.length;
  }

  return `${value.slice(0, endOffset)}\n\n[truncated, ${totalBytes - usedBytes} more bytes]`;
}
