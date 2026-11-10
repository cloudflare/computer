/**
 * `codemode:exec`: remote exec as a computer host module, for codemode.
 *
 * Host modules exchange JSON-only values with the isolate, so this exports two layers:
 *
 * - `exec(argv, options)`: the whole call in one host call. Returns `{ exitCode, stdout, stderr,
 *   truncated?, sync }` once the command has exited and pull has finished.
 * - Primitives keyed by an execution id (`spawn`, `write`, `closeStdin`, `read`, `wait`, `kill`,
 *   `cancel`), which the isolate-side facade (`facade.ts`, imported as "codemode:remote-exec")
 *   turns into an `ExecProcess` with streams, like `ctx.container.exec()`'s.
 *
 * An execution is kept until it has exited and each of its streams has been read to the end or
 * cancelled, so output stays readable after exit, or until the code that spawned it has timed out.
 *
 * Bytes cross as base64. Output follows the Workspace's spill-over settings (`output.ts`).
 */
import { unsafeToRepeat } from "../runtime/replay-safety";
import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFactory,
  WorkspaceRuntimeValue,
} from "../runtime/types";
import { remoteExec, type RemoteExecOptions, type RemoteProcess, DEFAULT_AGENT_PATH } from "./exec";
import { asBytes } from "./framing";
import type { SyncFs } from "./fs";
import { ensureRemoteExec, type RemoteExecBinaries } from "./install";
import {
  OutputCapture,
  outputSettings,
  type Captured,
  type Truncation,
  type WorkspaceOutputOptions,
} from "./output";
import { RemoteExecError } from "./session";
import type { SyncLimits, SyncReport } from "./sync";
import type { ExecTarget, ResolveTarget } from "./target";

export interface ExecModuleOptions {
  target: ResolveTarget;
  /** What every command's environment starts with, under the call's own `env`. */
  env?: (context: WorkspaceModuleCallContext) => Promise<Record<string, string>>;
  fs: () => SyncFs;
  /** The same value given to `new Workspace({ output })`. */
  output?: WorkspaceOutputOptions | false;
  workspaceRoot?: string;
  containerRoot?: string;
  agentPath?: string;
  /**
   * The remote-exec builds the Worker carries (`fileRemoteExec()` or `bundledRemoteExec()`),
   * copied to `agentPath` unless it already holds the same build. Leave it out when the image has
   * remote-exec at `agentPath` already.
   */
  binaries?: RemoteExecBinaries;
  limits?: Partial<SyncLimits>;
  /** Read-ahead per stream for the streaming facade. */
  maxStreamBuffer?: number;
  /**
   * How long a stream that has been read may go unread, with its read-ahead full, before it stops
   * holding the command back, in ms. Default 30 seconds. Until then a full read-ahead pauses the
   * command, as a pipe does; after it, the rest of the output goes only to the result (`output()`,
   * `truncated`), so a caller that read part of a stream and moved on to `exitCode` doesn't wait
   * for ever. Reading the stream again then fails, saying so.
   */
  streamStallMs?: number;
  /**
   * How long the calling code may run: commands are stopped when it times out, and output nobody
   * has read is dropped once the code that spawned it can no longer be running.
   */
  runTimeoutMs: number;
  /**
   * For code that may only read: commands run as `READ_ONLY_USER`, pushed files stay root's, and
   * `pull` and `user` are refused. Pull writes through `fs`, past the backend's read-only guard.
   */
  readOnly?: boolean;
}

/** nobody: a read-only agent's commands can read what's pushed, but not change it. */
const READ_ONLY_USER = "65534:65534";

const DESCRIPTION = [
  "Runs a command in a Linux container, copying workspace files in before and changed files back after.",
  'Call `const { exitCode, stdout, stderr, sync } = await exec(["npm", "test"], { cwd: "/workspace/app", push: ["**"], pull: ["coverage/**"] })`.',
  'argv runs directly, with no shell: use `["sh", "-c", "..."]` for pipes and redirects.',
  "`push` globs are copied into the container before the command starts and `pull` globs are copied back after it exits; both respect .gitignore. Relative globs are relative to `cwd` (default /workspace), like the command's own paths; `/workspace/...` globs work too.",
  'Commands start with the image\'s environment plus any the host adds. Other options: `user` ("uid:gid"), `env` (added over those), `stdin` (a string), `stdout`/`stderr` ("ignore"), `lockTimeoutMs`.',
  "File modes cross both ways. To make a workspace file executable, call node:fs `chmod` after writing it, or `chmod +x` in the command: writeFile's `mode` option isn't kept, and rewriting a file resets it to 644.",
  "Long output keeps its tail; `truncated.stdout.path` then names a workspace file with all of it.",
  "Commands that push or pull run one at a time. Everything a command starts is stopped when it exits.",
  'For streams, stdin piping and kill(), `import { exec } from "codemode:remote-exec"` instead: it returns a process like ctx.container.exec().',
].join(" ");

type Json = WorkspaceRuntimeValue;

function obj(value: Json | undefined, what: string): Record<string, Json> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`exec: ${what} must be an object`);
  return value;
}

function strings(value: Json | undefined, what: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new TypeError(`exec: ${what} must be an array of strings`);
  return value as string[];
}

function str(value: Json | undefined, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError(`exec: ${what} must be a string`);
  return value;
}

function oneOf<T extends string>(
  value: Json | undefined,
  allowed: readonly T[],
  what: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new TypeError(`exec: ${what} must be one of ${allowed.join(", ")}`);
  return value as T;
}

const OPTION_KEYS = new Set([
  "push",
  "pull",
  "user",
  "cwd",
  "env",
  "stdin",
  "stdinBase64",
  "stdout",
  "stderr",
  "lockTimeoutMs",
]);

function parseOptions(raw: Json | undefined): {
  options: RemoteExecOptions;
  stdinData?: Uint8Array<ArrayBuffer>;
  pipeStdin: boolean;
} {
  const o = obj(raw, "options");
  for (const key of Object.keys(o))
    if (!OPTION_KEYS.has(key)) throw new TypeError(`exec: unknown option ${JSON.stringify(key)}`);
  const env = obj(o.env, "env");
  for (const [k, v] of Object.entries(env))
    if (typeof v !== "string")
      throw new TypeError(`exec: env ${JSON.stringify(k)} must be a string`);
  const options: RemoteExecOptions = {
    push: strings(o.push, "push"),
    pull: strings(o.pull, "pull"),
    user: str(o.user, "user"),
    cwd: str(o.cwd, "cwd"),
    env: env as Record<string, string>,
    stdout: oneOf(o.stdout, ["pipe", "ignore"] as const, "stdout"),
    stderr: oneOf(o.stderr, ["pipe", "ignore", "combined"] as const, "stderr"),
  };
  if (typeof o.lockTimeoutMs === "number") options.lockTimeoutMs = o.lockTimeoutMs;
  let stdinData: Uint8Array<ArrayBuffer> | undefined;
  let pipeStdin = false;
  if (o.stdin === "pipe") pipeStdin = true;
  else if (typeof o.stdin === "string") stdinData = new TextEncoder().encode(o.stdin);
  else if (typeof o.stdinBase64 === "string") stdinData = fromBase64(o.stdinBase64);
  else if (o.stdin !== undefined && o.stdin !== null)
    throw new TypeError('exec: stdin must be a string or "pipe"');
  return { options, ...(stdinData === undefined ? {} : { stdinData }), pipeStdin };
}

function readOnlyOptions(options: RemoteExecOptions): RemoteExecOptions {
  if (options.pull !== undefined)
    throw new TypeError(
      "exec: this agent can only read files, so it can't pull files back into the workspace",
    );
  if (options.user !== undefined)
    throw new TypeError(
      `exec: this agent can only read files, so its commands run as nobody (${READ_ONLY_USER}) and it can't choose a user`,
    );
  return { ...options, user: READ_ONLY_USER, pushOwner: "" };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

class StreamPump {
  readonly #readahead: Uint8Array[] = [];
  #bytes = 0;
  #reading = false;
  #overflowed = false;
  #cancelled = false;
  /** Read once, then left unread past `stallMs` with the read-ahead full. */
  #stalled = false;
  #eof = false;
  #drained: boolean;
  #wakeReader: (() => void) | undefined;
  #wakePump: (() => void) | undefined;
  readonly done: Promise<Captured>;

  constructor(
    stream: ReadableStream<Uint8Array> | undefined,
    capture: OutputCapture,
    private readonly max: number,
    private readonly name: string,
    private readonly stallMs: number,
  ) {
    this.#drained = stream === undefined;
    this.done = (async () => {
      if (stream) {
        for await (const raw of stream) {
          const chunk = asBytes(raw);
          await capture.write(chunk);
          if (this.#overflowed || this.#cancelled || this.#stalled) continue;
          while (this.#bytes + chunk.byteLength > this.max && !this.#cancelled) {
            if (!this.#reading) {
              // Nobody is streaming this output: stop buffering it, output() still has it.
              this.#overflowed = true;
              this.#readahead.length = 0;
              this.#bytes = 0;
              break;
            }
            // A reader takes a chunk larger than the read-ahead whole.
            if (this.#bytes === 0) break;
            // Hold the command back for a reader, as a pipe would, but not for one that's gone.
            const woken = await new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => resolve(false), this.stallMs);
              this.#wakePump = () => {
                clearTimeout(timer);
                resolve(true);
              };
            });
            this.#wakePump = undefined;
            if (!woken) {
              this.#stalled = true;
              this.#readahead.length = 0;
              this.#bytes = 0;
              break;
            }
          }
          if (!this.#overflowed && !this.#cancelled && !this.#stalled) {
            this.#readahead.push(chunk);
            this.#bytes += chunk.byteLength;
            this.#wakeReader?.();
          }
        }
      }
      this.#eof = true;
      this.#wakeReader?.();
      return capture.finish();
    })();
    this.done.catch(() => undefined);
  }

  async read(waitMs: number, signal: AbortSignal): Promise<{ data: Uint8Array; eof: boolean }> {
    if (this.#cancelled) throw new Error("exec: this stream was cancelled");
    if (this.#overflowed)
      throw new Error(
        "exec: this stream passed its read-ahead before it was first read; use output() instead",
      );
    if (this.#stalled)
      throw new Error(
        `exec: ${this.name} went unread for ${this.stallMs} ms with its read-ahead full, so it ` +
          "stopped holding the command back; the rest of its output is in the result",
      );
    this.#reading = true;
    if (this.#bytes === 0 && !this.#eof && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        this.#wakeReader = wake;
        signal.addEventListener("abort", wake, { once: true });
      });
      this.#wakeReader = undefined;
    }
    const data = new Uint8Array(this.#bytes);
    let at = 0;
    for (const c of this.#readahead.splice(0)) {
      data.set(c, at);
      at += c.byteLength;
    }
    this.#bytes = 0;
    this.#wakePump?.();
    this.#wakePump = undefined;
    const eof = this.#eof && this.#readahead.length === 0;
    if (eof) this.#drained = true;
    return { data, eof };
  }

  /** Nobody will read this stream: stop buffering it. output() still has it. */
  cancel(): void {
    this.#cancelled = true;
    this.#readahead.length = 0;
    this.#bytes = 0;
    this.#wakePump?.();
    this.#wakePump = undefined;
  }

  /** Read to the end, cancelled, stalled, or never piped. */
  get settled(): boolean {
    return this.#drained || this.#cancelled || this.#stalled;
  }
}

interface Execution {
  proc: RemoteProcess;
  finished: boolean;
  /** When the code that spawned it has timed out. */
  expiresAt: number;
  stdin: WritableStreamDefaultWriter<Uint8Array> | undefined;
  stdout: StreamPump;
  stderr: StreamPump;
}

interface ExecResult {
  exitCode: number;
  /** Text for `exec`; base64 for `wait`, which the facade decodes to bytes. */
  stdout: string;
  stderr: string;
  truncated?: Truncation;
  sync: { pushed: SyncReport; pulled: SyncReport };
}

export function createExecModule(options: ExecModuleOptions): WorkspaceModuleFactory {
  const executions = new Map<string, Execution>();
  const settings = outputSettings(options.output);
  const agentPath = options.agentPath ?? DEFAULT_AGENT_PATH;
  const maxStreamBuffer = options.maxStreamBuffer ?? 1024 * 1024;
  const streamStallMs = options.streamStallMs ?? 30_000;
  let installed: Promise<unknown> | undefined;

  const target = async (context: WorkspaceModuleCallContext): Promise<ExecTarget> => {
    const t = await options.target(context);
    installed ??= ensureRemoteExec(t, agentPath, options.binaries).catch((e: unknown) => {
      installed = undefined;
      throw e;
    });
    await installed;
    return t;
  };

  const start = async (
    argv: Json | undefined,
    rawOptions: Json | undefined,
    context: WorkspaceModuleCallContext,
  ) => {
    if (!options.readOnly && context.access !== "read-write")
      throw new Error("codemode:exec requires Workspace write access.");
    const parsed = parseOptions(rawOptions);
    const own = options.readOnly ? readOnlyOptions(parsed.options) : parsed.options;
    const execOptions = { ...own, env: { ...(await options.env?.(context)), ...own.env } };
    const args = strings(argv, "argv");
    if (!args?.length) throw new TypeError("exec: argv must be a non-empty array of strings");
    dropExpired();
    const fs = options.fs();
    const spawnedAt = Date.now();
    const id = `x${context.callId.replace(/[^A-Za-z0-9]/g, "").slice(-40)}${Math.random().toString(36).slice(2, 8)}`;
    const stdin = parsed.stdinData
      ? new Blob([parsed.stdinData]).stream()
      : parsed.pipeStdin
        ? "pipe"
        : undefined;
    const run = async () =>
      remoteExec(
        {
          target: await target(context),
          fs,
          agentPath,
          id,
          ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
          ...(options.containerRoot ? { containerRoot: options.containerRoot } : {}),
          ...(options.limits ? { limits: options.limits } : {}),
        },
        args,
        { ...execOptions, ...(stdin === undefined ? {} : { stdin }) },
      );
    let proc: RemoteProcess;
    try {
      proc = await run();
    } catch (error) {
      // A container replaced since the last install (a fresh image, a lost snapshot) no longer
      // has the binary: forget that it was installed and try once more. Errors about the call
      // itself (a bad option, a command that can't start) aren't retried.
      if (
        error instanceof TypeError ||
        (error instanceof RemoteExecError && error.code !== "session")
      ) {
        throw error;
      }
      installed = undefined;
      proc = await run();
    }
    const execution: Execution = {
      proc,
      finished: false,
      expiresAt: spawnedAt + options.runTimeoutMs,
      stdin: proc.stdin?.getWriter(),
      stdout: new StreamPump(
        proc.stdout,
        new OutputCapture(fs, settings, `${id}.stdout.log`),
        maxStreamBuffer,
        "stdout",
        streamStallMs,
      ),
      stderr: new StreamPump(
        proc.stderr,
        new OutputCapture(fs, settings, `${id}.stderr.log`),
        maxStreamBuffer,
        "stderr",
        streamStallMs,
      ),
    };
    executions.set(id, execution);
    return { id, execution };
  };

  const release = (id: string, execution: Execution) => {
    if (execution.finished && execution.stdout.settled && execution.stderr.settled)
      executions.delete(id);
  };

  const dropExpired = () => {
    const now = Date.now();
    for (const [id, execution] of executions)
      if (execution.finished && execution.expiresAt <= now) executions.delete(id);
  };

  const finish = async (
    id: string,
    execution: Execution,
    context: WorkspaceModuleCallContext,
    encoding: "text" | "base64",
  ): Promise<ExecResult> => {
    const kill = () => execution.proc.kill(9);
    context.signal.addEventListener("abort", kill, { once: true });
    if (context.signal.aborted) kill();
    try {
      const exitCode = await execution.proc.exitCode;
      const [out, err] = await Promise.all([execution.stdout.done, execution.stderr.done]);
      const truncated: Truncation = {};
      if (out.truncated) truncated.stdout = out.truncated;
      if (err.truncated) truncated.stderr = err.truncated;
      const decoder = new TextDecoder();
      const encode = (bytes: Uint8Array) =>
        encoding === "text" ? decoder.decode(bytes) : toBase64(bytes);
      return {
        exitCode,
        stdout: encode(out.kept),
        stderr: encode(err.kept),
        ...(Object.keys(truncated).length ? { truncated } : {}),
        sync: { pushed: execution.proc.pushed, pulled: await execution.proc.pulled },
      };
    } finally {
      context.signal.removeEventListener("abort", kill);
      execution.finished = true;
      release(id, execution);
    }
  };

  const get = (id: Json | undefined): Execution => {
    dropExpired();
    const execution = typeof id === "string" ? executions.get(id) : undefined;
    if (!execution) throw new Error(`exec: no running execution ${JSON.stringify(id)}`);
    return execution;
  };

  const create = () => ({
    // A command can't be run twice safely: on a replay, fail the run instead.
    exec: unsafeToRepeat(async (args: readonly Json[], context: WorkspaceModuleCallContext) => {
      const { id, execution } = await start(args[0], args[1], context);
      execution.stdout.cancel();
      execution.stderr.cancel();
      return (await finish(id, execution, context, "text")) as unknown as Json;
    }),
    spawn: unsafeToRepeat(async (args: readonly Json[], context: WorkspaceModuleCallContext) => {
      const { id, execution } = await start(args[0], args[1], context);
      return { id, pid: execution.proc.pid, pushed: execution.proc.pushed as unknown as Json };
    }),
    write: async (args: readonly Json[]) => {
      const execution = get(args[0]);
      if (!execution.stdin) throw new Error('exec: stdin isn\'t "pipe"');
      await execution.stdin.write(fromBase64(str(args[1], "data") ?? ""));
      return null;
    },
    closeStdin: async (args: readonly Json[]) => {
      await get(args[0]).stdin?.close();
      return null;
    },
    read: async (args: readonly Json[], context: WorkspaceModuleCallContext) => {
      const execution = get(args[0]);
      const which = oneOf(args[1], ["stdout", "stderr"] as const, "stream") ?? "stdout";
      const waitMs = Math.max(
        0,
        Math.min(Number(args[2] ?? 50), Math.max(0, context.deadline - Date.now() - 100)),
      );
      const { data, eof } = await execution[which].read(waitMs, context.signal);
      release(str(args[0], "id") ?? "", execution);
      return { data: toBase64(data), eof };
    },
    wait: async (args: readonly Json[], context: WorkspaceModuleCallContext) => {
      const id = str(args[0], "id") ?? "";
      return (await finish(id, get(id), context, "base64")) as unknown as Json;
    },
    abort: async (args: readonly Json[]) => {
      get(args[0]).proc.abort();
      return null;
    },
    cancel: async (args: readonly Json[]) => {
      const id = str(args[0], "id") ?? "";
      const execution = get(id);
      const which = oneOf(args[1], ["stdout", "stderr"] as const, "stream");
      for (const stream of which ? [which] : (["stdout", "stderr"] as const))
        execution[stream].cancel();
      release(id, execution);
      return null;
    },
    kill: async (args: readonly Json[]) => {
      const signal = typeof args[1] === "number" ? args[1] : 15;
      get(args[0]).proc.kill(signal);
      return null;
    },
  });
  const limit = ` Commands are stopped when this code times out, after ${Math.round(options.runTimeoutMs / 60_000)} minutes: split longer work across calls.`;
  return Object.assign(create, { description: DESCRIPTION + limit });
}

export { RemoteExecError };
