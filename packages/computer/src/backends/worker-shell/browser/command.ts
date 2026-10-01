// `browser` custom command for the Worker Shell isolate.
//
// The shell cannot drive a browser itself: Puppeteer's client, its
// Browser Run transport, and the page objects it hands out all live
// in the worker-javascript backend that carries the Puppeteer
// plugin. This command is the shell-side half of that split. It
// resolves the caller's task module, generates the entry that opens
// and closes the browser around it, and dispatches that entry back
// through the host Workspace runtime.
//
// Nothing browser-shaped crosses this boundary. What comes back is
// the task's structured result, its output, and its exit code.
//
// Argv parsing and entry generation live in cli.ts; this file only
// adapts them to the just-bash Command signature.

// just-bash is imported for types only. `defineCommand` would be
// the natural constructor, but this group is bundled on its own and
// a value import would pull just-bash's whole published bundle into
// it; the command object is three fields, so build it directly.
// Matches defineCommand's own output, including its trusted default.
import type { Command, CustomCommand, ResolvedCommandContext } from "just-bash";

import { BROWSER_USAGE, browserEntryModule, parseBrowserCommand, resolveTaskPath } from "./cli.js";

/** Result of one JavaScript execution, as the host runtime reports it. */
export interface BrowserRuntimeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  value?: unknown;
}

/** Handle the host runtime returns for a dispatched execution. */
export interface BrowserRuntimeHandle {
  readonly id: string | PromiseLike<string>;
  result(): Promise<BrowserRuntimeResult>;
  [Symbol.dispose]?(): void;
}

/** Structural subset of `workspace.runtime` the command dispatches through. */
export interface BrowserCommandRuntime {
  exec(
    source: string,
    options: {
      backend?: string;
      cwd?: string;
      input?: unknown;
      timeoutMs?: number;
      encoding?: "utf8";
    },
  ): Promise<BrowserRuntimeHandle>;
  killExec(id: string, options?: { backend?: string }): Promise<void>;
}

/** Structural subset of the host stub the command needs. */
export interface BrowserCommandHost {
  fs: {
    exists(path: string): Promise<boolean>;
    writeFile(path: string, content: string): Promise<void>;
    rm(path: string, options?: { force?: boolean }): Promise<void>;
  };
  runtime: BrowserCommandRuntime;
}

// Backend the task runs on unless the caller names another. Matches
// WorkerJavaScriptBackend's own default id, so a workspace that
// registers one JavaScript backend needs no configuration.
const DEFAULT_BACKEND = "worker-javascript";
const BACKEND_ENV = "BROWSER_BACKEND";

/**
 * Build a `browser` custom command bound to a host workspace stub.
 *
 * The closure captures `ws` for the duration of `bash.exec`, which
 * `ShellWorker.exec` already keeps alive until Bash settles. No new
 * disposal contract: the per-execution handle this command opens is
 * disposed here, before the command returns.
 */
export function defineBrowserCommand(ws: BrowserCommandHost): CustomCommand {
  const execute: Command["execute"] = async (args: string[], ctx: ResolvedCommandContext) => {
    const request = parseBrowserCommand(args);
    if (request.kind === "help") {
      return { stdout: BROWSER_USAGE, stderr: "", exitCode: 0 };
    }
    if (request.kind === "error") {
      return { stdout: "", stderr: `browser: ${request.message}\n`, exitCode: 2 };
    }

    let task: { path: string; cwd: string; specifier: string };
    let temporary = false;
    let pendingSource: string | undefined;
    if (request.stdin) {
      const source = decodeStdin(ctx.stdin as unknown as string);
      if (source.trim() === "") {
        return { stdout: "", stderr: "browser: no task module on stdin\n", exitCode: 2 };
      }
      task = resolveTaskPath(ctx.cwd, `.browser-task-${crypto.randomUUID()}.js`);
      temporary = true;
      pendingSource = source;
    } else {
      task = resolveTaskPath(ctx.cwd, request.script as string);
      if (!(await ws.fs.exists(task.path))) {
        return { stdout: "", stderr: `browser: no such task module: ${task.path}\n`, exitCode: 1 };
      }
    }

    const backend = ctx.env.get(BACKEND_ENV) || DEFAULT_BACKEND;
    const input: Record<string, unknown> = { ...request.input };
    if (request.url !== undefined) input.url = request.url;

    try {
      // The write happens inside this scope because a write that fails
      // partway can still leave the file behind, and the cleanup below
      // is what removes it.
      if (pendingSource !== undefined) await ws.fs.writeFile(task.path, pendingSource);
      return await dispatch(ws, {
        backend,
        cwd: task.cwd,
        entry: browserEntryModule(
          task.specifier,
          request.url === undefined ? undefined : new URL(request.url).hostname,
        ),
        input,
        timeoutMs: request.timeoutMs,
        signal: ctx.signal,
      });
    } catch (error) {
      return failure(error);
    } finally {
      if (temporary) {
        try {
          await ws.fs.rm(task.path, { force: true });
        } catch {
          // The task ran; a leftover temporary module is not worth
          // failing the command over.
        }
      }
    }
  };

  return { name: "browser", trusted: true, execute };
}

async function dispatch(
  ws: BrowserCommandHost,
  options: {
    backend: string;
    cwd: string;
    entry: string;
    input: Record<string, unknown>;
    timeoutMs: number | undefined;
    signal: AbortSignal | undefined;
  },
) {
  const handle = await ws.runtime.exec(options.entry, {
    backend: options.backend,
    cwd: options.cwd,
    input: options.input,
    timeoutMs: options.timeoutMs,
    encoding: "utf8",
  });

  let cancellation: Cancellation | undefined;
  try {
    const executionId = await handle.id;
    cancellation = watchCancellation(ws, executionId, options);
    // Both arms resolve rather than reject, so the losing promise in the
    // race below cannot end up rejected and unobserved.
    const settled = handle.result().then(
      (result) => ({ kind: "result" as const, result }),
      (error) => ({ kind: "failed" as const, error }),
    );
    const outcome = await (cancellation === undefined
      ? settled
      : Promise.race([settled, cancellation.cancelled]));

    // Stop waiting once the shell cancels. The caller is gone, and the
    // workspace stub this command borrowed is disposed as soon as it
    // returns, so waiting on a run owned by another backend would
    // outlive the authority to talk to it.
    if (outcome.kind === "cancelled") {
      const note =
        outcome.killFailure === undefined
          ? ""
          : ` (the task may still be running: ${messageOf(outcome.killFailure)})`;
      return { stdout: "", stderr: `browser: execution cancelled${note}\n`, exitCode: 130 };
    }
    if (outcome.kind === "failed") throw outcome.error;

    const { result } = outcome;
    const output = result.stdout ?? "";
    const value = result.value === undefined ? "" : `${JSON.stringify(result.value, null, 2)}\n`;
    const separator = output !== "" && value !== "" && !output.endsWith("\n") ? "\n" : "";
    return {
      stdout: `${output}${separator}${value}`,
      stderr: result.stderr ?? "",
      exitCode: result.exitCode,
    };
  } finally {
    cancellation?.release();
    handle[Symbol.dispose]?.();
  }
}

interface Cancellation {
  cancelled: Promise<{ kind: "cancelled"; killFailure: unknown }>;
  release(): void;
}

// Ask the owning backend to stop the nested execution when the shell
// cancels, and report whether that request was accepted. A kill that
// fails leaves the run going, which the caller should hear about.
function watchCancellation(
  ws: BrowserCommandHost,
  id: string,
  options: { backend: string; signal: AbortSignal | undefined },
): Cancellation | undefined {
  const signal = options.signal;
  if (signal === undefined) return undefined;
  let onAbort: () => void = () => {};
  const cancelled = new Promise<{ kind: "cancelled"; killFailure: unknown }>((resolve) => {
    onAbort = () => {
      ws.runtime.killExec(id, { backend: options.backend }).then(
        () => resolve({ kind: "cancelled", killFailure: undefined }),
        (killFailure) => resolve({ kind: "cancelled", killFailure }),
      );
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return { cancelled, release: () => signal.removeEventListener("abort", onAbort) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// just-bash hands stdin over as a latin1-shaped byte buffer. Task
// modules are source text, so decode as UTF-8 and fall back to the
// raw view when the bytes are not valid UTF-8.
const UTF8_DECODER = /* @__PURE__ */ new TextDecoder("utf-8", { fatal: true });
function decodeStdin(value: string): string {
  if (value === "") return value;
  let high = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0xff) return value;
    if (code > 0x7f) high = true;
  }
  if (!high) return value;
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index);
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return value;
  }
}

function failure(error: unknown) {
  return { stdout: "", stderr: `browser: ${messageOf(error)}\n`, exitCode: 1 };
}
