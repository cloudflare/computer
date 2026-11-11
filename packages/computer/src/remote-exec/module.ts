/**
 * `codemode:exec`: remote exec as a codemode module.
 *
 * `exec(argv, options)` takes the platform's `ctx.container.exec()` options, plus `push`, `pull` and
 * `lockTimeoutMs`, and returns the platform's `ExecProcess`: `pid`, `isPty`, `stdin`, `stdout`,
 * `stderr`, `exitCode`, `output()`, `kill()` and `resize()`. The process is a codemode object, so its
 * streams and its exit code work in every run, replayable ones included, and it ends with the scope
 * that made it: when the run ends, pauses, or releases it, the command is killed.
 *
 * `output()` reads both streams to the end, keeping their tails under the Workspace's output
 * settings (`output.ts`), and adds what the platform's doesn't have: `truncated` and the `sync`
 * reports. It can be called once, and only before either stream has been read: they're the same
 * pipes, not copies.
 */
import {
  createCodemodeModule,
  field,
  promised,
  readable,
  writable,
} from "../runtime/codemode-module";
import type { CodemodeModule } from "../runtime/codemode-module";
import { unsafeToRepeat } from "../runtime/replay-safety";
import type { WorkspaceModuleCallContext } from "../runtime/types";
import { remoteExec, type RemoteExecOptions, type RemoteProcess, DEFAULT_AGENT_PATH } from "./exec";
import type { SyncFs } from "./fs";
import { ensureRemoteExec, type RemoteExecBinaries } from "./install";
import {
  type Captured,
  OutputCapture,
  outputSettings,
  type OutputSettings,
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
  /**
   * For code that may only read: commands run as `READ_ONLY_USER`, pushed files stay root's, and
   * `pull` and `user` are refused. Pull writes through `fs`, past the backend's read-only guard.
   */
  readOnly?: boolean;
}

/** What `output()` resolves with: the platform's `ExecOutput`, plus remote exec's own reports. */
export interface RemoteExecOutput {
  readonly stdout: ArrayBuffer;
  readonly stderr: ArrayBuffer;
  readonly exitCode: number;
  /** Where long output was saved, as the Workspace's output settings say. */
  readonly truncated?: Truncation;
  readonly sync: { readonly pushed: SyncReport; readonly pulled: SyncReport };
}

/** nobody: a read-only agent's commands can read what's pushed, but not change it. */
const READ_ONLY_USER = "65534:65534";

const DESCRIPTION = [
  "Runs a command in a Linux container, copying workspace files in before and changed files back after.",
  '`const proc = await exec(["npm", "test"], { cwd: "/workspace/app", push: ["**"], pull: ["coverage/**"] })` returns a process like ctx.container.exec()\'s:',
  "`pid`, `stdin`, `stdout` and `stderr` streams, `exitCode`, `output()` and `kill()`.",
  "`const { stdout, stderr, exitCode, truncated, sync } = await proc.output()` waits for the command and gives its output as ArrayBuffers (decode with TextDecoder), with what push and pull did.",
  "output() reads the same pipes as the streams, so call it once and only before reading them.",
  'As with ctx.container.exec(), `exitCode` resolves, and each stream ends, only once both stdout and stderr have been read to the end or cancelled, and a pipe nobody reads blocks the command once it fills: read the streams together, call output(), cancel or `"ignore"` what you don\'t need.',
  'argv runs directly, with no shell: use `["sh", "-c", "..."]` for pipes and redirects.',
  "`push` globs are copied into the container before the command starts and `pull` globs are copied back before `exitCode` resolves; both respect .gitignore. Relative globs are relative to `cwd` (default /workspace), like the command's own paths; `/workspace/...` globs work too.",
  'Other options, as ctx.container.exec() takes them: `user` ("uid:gid"), `env` (added over the image\'s), `stdin` ("pipe", a string or a ReadableStream), `stdout` ("pipe" or "ignore"), `stderr` ("pipe", "ignore" or "combined"), `signal`. Also `lockTimeoutMs`.',
  "File modes cross both ways. To make a workspace file executable, call node:fs `chmod` after writing it, or `chmod +x` in the command: writeFile's `mode` option isn't kept, and rewriting a file resets it to 644.",
  "Long output keeps its tail in output(); `truncated.stdout.path` then names a workspace file with all of it.",
  "Commands that push or pull run one at a time. Everything a command starts is stopped when it exits, and a command still running when the code ends, or pauses, is killed.",
].join(" ");

const GONE =
  "exec: this command is no longer running here: it was stopped when the run paused, or when the Durable Object restarted.";

/** A command this module started, while its scope lasts. */
interface Running {
  readonly proc: RemoteProcess;
  readonly settings: OutputSettings;
  readonly fs: SyncFs;
  readonly id: string;
  /** Read as a stream, or taken by output(): each pipe has one reader. */
  streamed: boolean;
  outputTaken: boolean;
  exited: boolean;
  /** The pipes as code's streams read them, once code has opened them. */
  readonly opened: Partial<Record<"stdout" | "stderr", ReadableStream<Uint8Array>>>;
}

/**
 * The command's pipe as code reads it. Cancelling it drains the pipe instead: a pipe that isn't
 * read to its end holds the command's exit back, and the platform's exec() fails a process
 * whose stream is cancelled outright.
 */
function drainOnCancel(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: () => drain(reader),
    },
    { highWaterMark: 0 },
  );
}

/** Read a pipe to its end, discarding it, in the background. */
function drain(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void (async () => {
    for (;;) if ((await reader.read()).done) return;
  })().catch(() => undefined);
}

/** The process as its object's state keeps it: enough to find it again, and its shape. */
interface ProcessState {
  readonly id: string;
  readonly pid: number;
  readonly stdin: boolean;
  readonly stdout: boolean;
  readonly stderr: boolean;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`exec: ${what} must be an object`);
  return value as Record<string, unknown>;
}

function strings(value: unknown, what: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new TypeError(`exec: ${what} must be an array of strings`);
  return value as string[];
}

function str(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError(`exec: ${what} must be a string`);
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new TypeError(`exec: ${what} must be one of ${allowed.join(", ")}`);
  return value as T;
}

const OPTION_KEYS = new Set([
  // ctx.container.exec()'s.
  "cwd",
  "env",
  "user",
  "signal",
  "pty",
  "stdin",
  "stdout",
  "stderr",
  // Remote exec's own.
  "push",
  "pull",
  "lockTimeoutMs",
]);

/** The options code passed, with a string `stdin` kept apart: it's made into a stream per attempt. */
interface ParsedOptions {
  readonly options: RemoteExecOptions;
  readonly stdinText: string | undefined;
}

function parseOptions(raw: unknown): ParsedOptions {
  const o = record(raw, "options");
  for (const key of Object.keys(o))
    if (!OPTION_KEYS.has(key)) throw new TypeError(`exec: unknown option ${JSON.stringify(key)}`);
  if (o.pty !== undefined && o.pty !== null && o.pty !== false)
    throw new TypeError("exec: remote exec has no pty");
  const env = record(o.env, "env");
  for (const [k, v] of Object.entries(env))
    if (typeof v !== "string")
      throw new TypeError(`exec: env ${JSON.stringify(k)} must be a string`);
  const stdin = o.stdin;
  if (
    stdin !== undefined &&
    stdin !== null &&
    typeof stdin !== "string" &&
    !(stdin instanceof ReadableStream)
  )
    throw new TypeError('exec: stdin must be "pipe", a string or a ReadableStream');
  const signal = o.signal;
  if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal))
    throw new TypeError("exec: signal must be an AbortSignal");
  const options: RemoteExecOptions = {
    push: strings(o.push, "push"),
    pull: strings(o.pull, "pull"),
    user: str(o.user, "user"),
    cwd: str(o.cwd, "cwd"),
    env: env as Record<string, string>,
    stdout: oneOf(o.stdout, ["pipe", "ignore"] as const, "stdout"),
    stderr: oneOf(o.stderr, ["pipe", "ignore", "combined"] as const, "stderr"),
  };
  if (stdin === "pipe" || stdin instanceof ReadableStream) {
    options.stdin = stdin as NonNullable<RemoteExecOptions["stdin"]>;
  }
  if (signal instanceof AbortSignal) options.signal = signal;
  if (typeof o.lockTimeoutMs === "number") options.lockTimeoutMs = o.lockTimeoutMs;
  // "pipe" asks for a writable stdin; any other string is the command's input.
  return { options, stdinText: typeof stdin === "string" && stdin !== "pipe" ? stdin : undefined };
}

/** A string as a stream of its UTF-8 bytes, for a command's stdin. */
function textStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
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

function signalOf(value: unknown): number {
  const signal = value === undefined || value === null ? 15 : value;
  if (typeof signal !== "number" || !Number.isInteger(signal) || signal < 1 || signal > 64)
    throw new RangeError("exec: signal must be 1 to 64");
  return signal;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Read both pipes to the end, keeping their tails, then wait for the exit and the pull. */
async function takeOutput(running: Running): Promise<RemoteExecOutput> {
  if (running.outputTaken) throw new TypeError("exec: output() can only be called once");
  if (running.streamed)
    throw new TypeError(
      "exec: output() reads stdout and stderr, so it can't be called once either has been read",
    );
  running.outputTaken = true;
  const { proc, fs, settings, id } = running;
  const capture = async (
    stream: ReadableStream<Uint8Array> | undefined,
    which: string,
  ): Promise<Captured> =>
    stream === undefined
      ? { kept: new Uint8Array() }
      : new OutputCapture(fs, settings, `${id}.${which}.log`).consume(stream);
  const [out, err, exitCode] = await Promise.all([
    capture(proc.stdout, "stdout"),
    capture(proc.stderr, "stderr"),
    proc.exitCode,
  ]);
  const truncated: Truncation = {};
  if (out.truncated) truncated.stdout = out.truncated;
  if (err.truncated) truncated.stderr = err.truncated;
  return {
    stdout: arrayBuffer(out.kept),
    stderr: arrayBuffer(err.kept),
    exitCode,
    ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
    sync: { pushed: proc.pushed, pulled: await proc.pulled },
  };
}

export function createExecModule(options: ExecModuleOptions): CodemodeModule {
  const settings = outputSettings(options.output);
  const agentPath = options.agentPath ?? DEFAULT_AGENT_PATH;
  // The commands this module is running, by id, while the scopes that started them last. A
  // process rebuilt in a later scope, or after a restart, finds nothing here.
  const running = new Map<string, Running>();
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

  const module = createCodemodeModule({ description: DESCRIPTION });

  const Process = module.define("Process", (state: ProcessState) => {
    const live = (): Running => {
      const entry = running.get(state.id);
      if (entry === undefined) throw new Error(GONE);
      return entry;
    };
    const pipe = (which: "stdout" | "stderr") => () => {
      const entry = live();
      if (entry.outputTaken) throw new TypeError(`exec: output() has already read ${which}`);
      const stream = entry.proc[which];
      if (stream === undefined) throw new TypeError(`exec: ${which} isn't piped`);
      entry.streamed = true;
      return (entry.opened[which] ??= drainOnCancel(stream));
    };
    return {
      pid: field(state.pid),
      isPty: field(false),
      stdin: state.stdin
        ? writable(() => {
            const stream = live().proc.stdin;
            if (stream === undefined) throw new TypeError('exec: stdin isn\'t "pipe"');
            return stream;
          })
        : field(null),
      stdout: state.stdout ? readable(pipe("stdout")) : field(null),
      stderr: state.stderr ? readable(pipe("stderr")) : field(null),
      // After the pull, so its files are in the workspace by then.
      exitCode: promised(() => live().proc.exitCode),
      output: async () => takeOutput(live()) as never,
      kill: async ([signal]) => {
        const number = signalOf(signal);
        live().proc.kill(number);
        return null;
      },
      resize: async () => {
        throw new TypeError("exec: remote exec has no pty, so it can't be resized");
      },
      // The scope that made it ended, paused, or let it go: kill what's still running, which also
      // skips its pull. A pipe nobody reads holds the command's exit back, and with it the end of
      // its session and the root's lock, so drain whatever is still unread.
      [Symbol.asyncDispose]: async () => {
        const entry = running.get(state.id);
        if (entry === undefined) return;
        running.delete(state.id);
        if (!entry.exited) entry.proc.abort();
        for (const which of ["stdout", "stderr"] as const) {
          const opened = entry.opened[which];
          const source = entry.proc[which];
          if (opened !== undefined) {
            // Code's stream: the bridge may still hold its reader, so cancel through it if not.
            if (!opened.locked) void opened.cancel().catch(() => undefined);
          } else if (source !== undefined && !source.locked) {
            drain(source.getReader());
          }
        }
      },
    };
  });

  return module.module({
    // A command can't be run twice safely: an interruption during this call fails the run.
    exec: unsafeToRepeat(async ([argv, rawOptions], context) => {
      if (!options.readOnly && context.access !== "read-write")
        throw new Error("codemode:exec requires Workspace write access.");
      const args = strings(argv, "argv");
      if (!args?.length) throw new TypeError("exec: argv must be a non-empty array of strings");
      const { options: parsed, stdinText } = parseOptions(rawOptions);
      const own = options.readOnly ? readOnlyOptions(parsed) : parsed;
      const execOptions: RemoteExecOptions = {
        ...own,
        env: { ...(await options.env?.(context)), ...own.env },
      };
      // Before anything reaches the container, not even the install check.
      if (execOptions.signal?.aborted) {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }
      const fs = options.fs();
      const id = `x${context.callId.replace(/[^A-Za-z0-9]/g, "").slice(-40)}${Math.random().toString(36).slice(2, 8)}`;
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
          // A string's stream is made for each attempt, so unlike a caller's stream it can retry.
          stdinText === undefined ? execOptions : { ...execOptions, stdin: textStream(stdinText) },
        );
      let proc: RemoteProcess;
      try {
        proc = await run();
      } catch (error) {
        // A container replaced since the last install (a fresh image, a lost snapshot) no longer
        // has the binary: forget that it was installed and try once more. Errors about the call
        // itself (a bad option, a command that can't start, an abort) aren't retried. A stream
        // passed as stdin can only be read once, so neither is a call that took one.
        if (
          error instanceof TypeError ||
          (error instanceof Error && error.name === "AbortError") ||
          (error instanceof RemoteExecError && error.code !== "session") ||
          execOptions.stdin instanceof ReadableStream
        ) {
          throw error;
        }
        installed = undefined;
        proc = await run();
      }
      const entry: Running = {
        proc,
        settings,
        fs,
        id,
        streamed: false,
        outputTaken: false,
        exited: false,
        opened: {},
      };
      const exited = () => {
        entry.exited = true;
      };
      proc.exitCode.then(exited, exited);
      running.set(id, entry);
      return Process({
        id,
        pid: proc.pid,
        stdin: execOptions.stdin === "pipe",
        stdout: (execOptions.stdout ?? "pipe") === "pipe",
        stderr: (execOptions.stderr ?? "pipe") === "pipe",
      });
    }),
  });
}

export { RemoteExecError };
