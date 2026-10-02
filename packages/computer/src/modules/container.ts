// `ws:container`: lets isolate JavaScript run shell commands in the
// Workspace's container backend.
//
// Installed on a WorkerJavaScriptBackend, it turns the container into a
// library the JavaScript backend calls, rather than a second backend
// the model has to choose between:
//
//   import { exec } from "ws:container";
//   const { exitCode, stdout } = await exec("npm test", { cwd: "/workspace" });
//
// Each call goes through `workspace.runtime.exec`, so the container
// sees the same files as the isolate: the usual sync bracket pushes
// pending Workspace writes before the command and pulls the
// container's changes after it.

import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFactory,
  WorkspaceModuleFunction,
  WorkspaceModuleFunctions,
  WorkspaceModuleHost,
  WorkspaceRuntimeValue,
} from "../runtime/types.js";
import type { ExecSyncResult } from "../shell.js";
import { truncateText } from "../text-truncation.js";

const DEFAULT_BACKEND = "container-shell";
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const EXEC_OPTION_KEYS = new Set(["cwd", "env", "stdin", "timeoutMs"]);

/** Options for {@link createContainerModule}. */
export interface ContainerModuleOptions {
  /** Id of the container backend. Defaults to `"container-shell"`. */
  readonly backend?: string;
  /**
   * Largest standard output and standard error returned to the
   * isolate, in bytes per stream. Longer output keeps its last lines
   * (up to 2000), and the runtime saves all of it to a Workspace file
   * that `truncated` names. Defaults to 64 KiB. Keep both streams well
   * under the backend's `maxCapabilityBytes`.
   */
  readonly maxOutputBytes?: number;
}

/**
 * Build the `ws:container` host module over the Workspace's container
 * backend.
 *
 * It exports `exec(command, { cwd, env, stdin, timeoutMs })`, which
 * returns `{ exitCode, stdout, stderr, sync }` once the command
 * finishes. `sync` reports whether the container's file changes reached
 * the Workspace, and which paths it skipped. A
 * non-zero exit code is a normal result, not an error. Cancelling the
 * execution kills the command.
 *
 * A container command can write to the Workspace, so `exec` refuses to
 * run on a read-only backend. Network access follows the container
 * backend's own egress setting; the JavaScript backend's does not apply.
 *
 * @param options - Which backend to use and how much output to return.
 * @returns The module to pass as `modules["ws:container"]`. Its
 *   `description` tells the model how to use it.
 * @throws When `maxOutputBytes` is not a positive integer. The module
 *   also throws when the backend connects if the Workspace has no
 *   such backend, or that backend runs module source rather than shell
 *   commands. A callable shell backend is fine.
 */
export function createContainerModule(
  options: ContainerModuleOptions = {},
): WorkspaceModuleFactory {
  const backend = options.backend ?? DEFAULT_BACKEND;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("createContainerModule: maxOutputBytes must be a positive integer.");
  }

  const create = (host: WorkspaceModuleHost): WorkspaceModuleFunctions => {
    // The factory runs when the JavaScript backend connects, so a
    // missing or wrong container backend fails there, before any code
    // runs, rather than on the first exec.
    const target = host.runtime.backends().find((info) => info.id === backend);
    if (target === undefined) {
      throw new Error(
        `ws:container: the Workspace has no backend ${JSON.stringify(backend)}. Register a ContainerBackend, or pass createContainerModule({ backend }).`,
      );
    }
    // A module backend reads `exec` source as code, so a shell command
    // sent there would run as JavaScript, or start a nested run.
    if (target.protocol !== "command") {
      throw new Error(
        `ws:container: backend ${JSON.stringify(backend)} runs module source, not shell commands.`,
      );
    }
    return { exec: execOn(host) };
  };
  const execOn =
    (host: WorkspaceModuleHost): WorkspaceModuleFunction =>
    async (args, context) => {
      if (context.access !== "read-write") {
        throw new Error("ws:container exec requires Workspace write access.");
      }
      const request = parseExecArgs(args);
      const timeoutMs = remainingTime(request.timeoutMs, context);
      context.signal.throwIfAborted();

      const handle = await host.runtime.exec(request.command, {
        backend,
        encoding: "utf8",
        timeoutMs,
        // The runtime keeps only the end of long output in memory and
        // saves the rest to a file, so a noisy command cannot exhaust
        // the Durable Object.
        output: { maxBytes: maxOutputBytes },
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
        // A Workspace with `output: false` returns everything, so cut
        // here too; the runtime already cut a stream it reports.
        return {
          exitCode: result.exitCode,
          stdout:
            result.truncated?.stdout === undefined
              ? truncateText(result.stdout, maxOutputBytes)
              : result.stdout,
          stderr:
            result.truncated?.stderr === undefined
              ? truncateText(result.stderr, maxOutputBytes)
              : result.stderr,
          ...(result.truncated === undefined ? {} : { truncated: { ...result.truncated } }),
          sync: syncSummary(result.sync),
        };
      } finally {
        context.signal.removeEventListener("abort", kill);
      }
    };
  return Object.assign(create, { description: DESCRIPTION });
}

const DESCRIPTION = [
  "Runs shell commands in a full Linux container that shares this workspace's files.",
  "Use it for npm, node, python, package managers, and native binaries. The container can take a while to start on first use.",
  'Call `const { exitCode, stdout, stderr } = await exec("npm test", { cwd: "/workspace" })`. Options are `cwd`, `env`, `stdin`, and `timeoutMs`.',
  "Output comes back when the command finishes. Long output keeps its last lines; `truncated.stdout.path` (or `truncated.stderr.path`) then names a workspace file holding all of it. The file usually sits outside this code's `node:fs` root, so return the path and open it with the agent's read or grep tools. A non-zero `exitCode` is returned, not thrown.",
  "`sync.status` is `pending` if the container's file changes have not reached the workspace yet. The container's changes win over files written meanwhile, so do not write files the command also writes while it runs.",
].join(" ");

// How the container's file changes came back to the Workspace. A
// "pending" status means they did not, yet; `skipped` lists paths the
// container wrote that the Workspace refused, such as read-only mounts.
function syncSummary(sync: ExecSyncResult) {
  return {
    status: sync.status,
    skipped: sync.skipped.map((entry) => entry.path),
    ...(sync.status === "pending" && sync.error !== undefined ? { error: sync.error } : {}),
  };
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
function remainingTime(requested: number | undefined, context: WorkspaceModuleCallContext) {
  const remaining = context.deadline - Date.now();
  if (remaining <= 0) throw new Error("exec: the host call deadline has already passed.");
  return requested === undefined ? remaining : Math.min(requested, remaining);
}
