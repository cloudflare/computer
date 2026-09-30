// A trusted module that lets isolate JavaScript run shell commands in
// the Workspace's container backend.
//
// Installed on a WorkerJavaScriptBackend as `ws:container`, it turns
// the container into a library the JavaScript backend calls, rather
// than a second backend the model has to choose between:
//
//   import { exec } from "ws:container";
//   const { exitCode, stdout } = await exec("npm test", { cwd: "/workspace" });
//
// Each call goes through `workspace.runtime.exec`, so the container
// sees the same files as the isolate: the usual sync bracket pushes
// pending Workspace writes before the command and pulls the
// container's changes after it.

import type {
  WorkspaceRuntimeValue,
  WorkspaceTrustedCallContext,
  WorkspaceTrustedFunction,
} from "../../runtime/types.js";

const DEFAULT_BACKEND = "container-shell";
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const EXEC_OPTION_KEYS = new Set(["cwd", "env", "stdin", "timeoutMs"]);

/** Options the container module passes to `workspace.runtime.exec`. */
export interface ContainerModuleExecOptions {
  /** Backend id the command runs on. */
  readonly backend: string;
  /** Output encoding. The module always asks for text. */
  readonly encoding: "utf8";
  /** Working directory inside the container. */
  readonly cwd?: string;
  /** Environment variables for this command only. */
  readonly env?: Record<string, string>;
  /** Text piped to the command's standard input. */
  readonly stdin?: string;
  /** Wall-clock limit for the command, in milliseconds. */
  readonly timeoutMs: number;
}

/** The part of a Workspace execution handle the container module uses. */
export interface ContainerModuleExecHandle {
  /** Wait for the command to finish and return its output. */
  result(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Stop the command. */
  kill(): Promise<void>;
}

/** The part of `workspace.runtime` the container module uses. */
export interface ContainerModuleRuntime {
  /** Start a command on a Workspace backend. */
  exec(command: string, options: ContainerModuleExecOptions): Promise<ContainerModuleExecHandle>;
}

/** Options for {@link createContainerModule}. */
export interface ContainerModuleOptions {
  /**
   * Returns the Workspace runtime. It is called on every command
   * rather than once, so the module can be built before the
   * Workspace that owns both backends: pass
   * `() => this.workspace.runtime`.
   */
  readonly runtime: () => ContainerModuleRuntime;
  /** Id of the container backend. Defaults to `"container-shell"`. */
  readonly backend?: string;
  /**
   * Largest standard output and standard error returned to the
   * isolate, in bytes per stream. Output past it is cut and ends with
   * a truncation marker. Defaults to 64 KiB. Keep both streams well
   * under the backend's `maxCapabilityBytes`.
   */
  readonly maxOutputBytes?: number;
}

/** The `ws:container` trusted module. */
export type ContainerModule = {
  /**
   * Run a shell command in the container.
   *
   * Isolate code calls `exec(command, { cwd, env, stdin, timeoutMs })`
   * and gets `{ exitCode, stdout, stderr }` back once the command
   * finishes. A non-zero exit code is a normal result, not an error.
   */
  readonly exec: WorkspaceTrustedFunction;
};

/**
 * Build the `ws:container` trusted module over a Workspace's container
 * backend.
 *
 * Install it only on a read-write JavaScript backend. A container
 * command can write to the Workspace and reach the network, whatever
 * the isolate's own access and egress settings are.
 *
 * @param options - How to reach the Workspace runtime and which backend to use.
 * @returns The module to pass as `trustedModules["ws:container"]`.
 * @throws When `maxOutputBytes` is not a positive integer. The host
 *   configured the module wrongly.
 */
export function createContainerModule(options: ContainerModuleOptions): ContainerModule {
  const backend = options.backend ?? DEFAULT_BACKEND;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("createContainerModule: maxOutputBytes must be a positive integer.");
  }

  return {
    async exec(args, context) {
      const request = parseExecArgs(args);
      const timeoutMs = remainingTime(request.timeoutMs, context);
      context.signal.throwIfAborted();

      const handle = await options.runtime().exec(request.command, {
        backend,
        encoding: "utf8",
        timeoutMs,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined ? {} : { env: request.env }),
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      });
      // Cancelling the isolate execution, or passing the host call
      // deadline, stops the command instead of leaving it running.
      const kill = () => void handle.kill().catch(() => undefined);
      if (context.signal.aborted) kill();
      else context.signal.addEventListener("abort", kill, { once: true });
      try {
        const result = await handle.result();
        return {
          exitCode: result.exitCode,
          stdout: truncate(result.stdout, maxOutputBytes),
          stderr: truncate(result.stderr, maxOutputBytes),
        };
      } finally {
        context.signal.removeEventListener("abort", kill);
      }
    },
  };
}

/**
 * Describe `ws:container` for a model.
 *
 * Append the returned text to the JavaScript backend's description in
 * the `exec` tool, so the model knows the module exists and when to
 * reach for it.
 *
 * @param specifier - The specifier the module is installed under.
 * @returns A short plain-text description with a usage example.
 */
export function describeContainerModule(specifier = "ws:container"): string {
  return [
    `\`import { exec } from ${JSON.stringify(specifier)}\` runs a shell command in a full Linux container that shares this workspace's files.`,
    "Use it for npm, node, python, package managers, native binaries, and network access. The container can take a while to start on first use.",
    'Call it as `const { exitCode, stdout, stderr } = await exec("npm test", { cwd: "/workspace" })`. Options are `cwd`, `env`, `stdin`, and `timeoutMs`.',
    "Output comes back when the command finishes, and long output is truncated. A non-zero `exitCode` is returned, not thrown.",
  ].join(" ");
}

interface ExecRequest {
  readonly command: string;
  readonly cwd: string | undefined;
  readonly env: Record<string, string> | undefined;
  readonly stdin: string | undefined;
  readonly timeoutMs: number | undefined;
}

// Arguments come from isolate code. A malformed call throws, and the
// bridge hands that error back to the isolate as a rejected promise.
function parseExecArgs(args: readonly WorkspaceRuntimeValue[]): ExecRequest {
  if (args.length === 0 || args.length > 2) {
    throw new TypeError("exec(command, options?) takes a command and an optional options object.");
  }
  const [command, options] = args;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new TypeError("exec: command must be a non-empty string.");
  }
  if (options === undefined || options === null) {
    return { command, cwd: undefined, env: undefined, stdin: undefined, timeoutMs: undefined };
  }
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("exec: options must be an object.");
  }
  for (const key of Object.keys(options)) {
    if (!EXEC_OPTION_KEYS.has(key)) {
      throw new TypeError(
        `exec: unknown option ${JSON.stringify(key)}. Use cwd, env, stdin, or timeoutMs.`,
      );
    }
  }
  return {
    command,
    cwd: optionalString(options.cwd, "cwd"),
    env: optionalEnv(options.env),
    stdin: optionalString(options.stdin, "stdin"),
    timeoutMs: optionalTimeout(options.timeoutMs),
  };
}

function optionalString(value: WorkspaceRuntimeValue | undefined, name: string) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError(`exec: ${name} must be a string.`);
  return value;
}

function optionalEnv(value: WorkspaceRuntimeValue | undefined) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("exec: env must be an object of strings.");
  }
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new TypeError(`exec: env ${JSON.stringify(key)} must be a string.`);
    }
    env[key] = entry;
  }
  return env;
}

function optionalTimeout(value: WorkspaceRuntimeValue | undefined) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("exec: timeoutMs must be a positive number.");
  }
  return value;
}

// The command must finish before the host call deadline, or the
// isolate stops waiting while the container keeps working. Cap the
// requested timeout at the time left.
function remainingTime(requested: number | undefined, context: WorkspaceTrustedCallContext) {
  const remaining = context.deadline - Date.now();
  if (remaining <= 0) throw new Error("exec: the host call deadline has already passed.");
  return requested === undefined ? remaining : Math.min(requested, remaining);
}

const encoder = new TextEncoder();

function truncate(value: string, maxBytes: number): string {
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
