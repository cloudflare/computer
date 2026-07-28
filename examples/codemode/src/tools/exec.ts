/**
 * `exec` — run one command inside the workspace's configured
 * backends. The tool exposes a `backend` parameter so the model
 * picks where each command runs.
 *
 * The `command` field means different things per backend, and the
 * descriptions on `ExecToolOptions.backends` spell that out:
 *
 *   - "shell" / "container" take a shell command line.
 *   - "codemode" takes a JavaScript snippet that reaches the files
 *     through a `state.*` namespace.
 *
 * The model reads each backend's description through the input
 * schema and decides which backend a given command belongs on.
 *
 * Adapted from the think example's exec tool. The workspace passed
 * in may be a live `Workspace` or a `WorkspaceStub`; both satisfy
 * `ExecWorkspaceLike`, so the loop can run wherever the caller
 * wants without the tool caring.
 */

import { tool } from "ai";
import { z } from "zod";

import { type ApprovalPolicy, decideApproval } from "../approval-policy.js";

/**
 * Minimal subset of `@cloudflare/workspace` we depend on: a shell
 * facade with `exec(command, { cwd, encoding, backend })` whose
 * handle resolves to `{ exitCode, stdout, stderr }`.
 */
export interface ExecWorkspaceLike {
  shell: {
    exec(
      command: string,
      options: { cwd?: string; encoding: "utf8"; backend?: string },
    ): Promise<{
      result(): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>;
    }>;
  };
}

export interface ExecBackendDescription {
  /**
   * One-paragraph summary of what this backend runs, and — since
   * `command` is not always a shell line — what shape the command
   * takes. The model reads it through the input-schema description
   * to decide which backend a given command belongs on.
   */
  description: string;
}

export interface ExecToolOptions {
  workspace: ExecWorkspaceLike;
  /**
   * The backend ids the tool advertises to the model. Each entry's
   * description is folded into the `backend` parameter's schema so
   * the model can read the tradeoffs. Keys must match the `id` of a
   * backend the underlying Workspace was constructed with.
   */
  backends: Record<string, ExecBackendDescription>;
  /**
   * Which backend the tool picks when the model omits `backend`.
   * Must be one of the keys in `backends`.
   */
  defaultBackend: string;
  /** Truncate captured stdout/stderr above this many bytes. */
  maxBytes?: number;
  /**
   * Which commands a human has to approve first. Omit to run
   * everything the model asks for.
   *
   * A gated call does not execute: the AI SDK reports it as an
   * approval request and ends the turn, so there is no provisional
   * result and nothing to undo.
   */
  policy?: ApprovalPolicy;
  /**
   * Called after each execution. The caller uses it to build a
   * transcript.
   *
   * Reading executions from `generateText`'s steps would miss the
   * interesting one: a command approved by a human runs before the
   * resumed pass makes its first model call, so it belongs to no step.
   * Recording here catches every execution regardless of which pass it
   * happened on.
   */
  onExec?: (call: ExecRecord) => void;
}

/** One command the tool actually ran. */
export interface ExecRecord {
  command: string;
  cwd: string | null;
  backend: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_MAX_BYTES = 64 * 1024; // 64 KiB per stream

export function createExecTool(opts: ExecToolOptions) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const backendIds = Object.keys(opts.backends);
  if (backendIds.length === 0) {
    throw new Error("createExecTool: pass at least one backend in `backends`");
  }
  if (!backendIds.includes(opts.defaultBackend)) {
    throw new Error(
      `createExecTool: defaultBackend ${JSON.stringify(opts.defaultBackend)} is not one of ${backendIds.map((id) => JSON.stringify(id)).join(", ")}`,
    );
  }

  const backendGuidance = backendIds
    .map((id) => `- ${JSON.stringify(id)}: ${opts.backends[id].description}`)
    .join("\n");

  const description = [
    "Run one command in the workspace. The workspace exposes",
    "multiple backends, each with different capabilities and, in",
    "one case, a different command language. Read the per-backend",
    "descriptions and pick the backend that fits the command.",
    "",
    "The `command` field is a shell command line for most backends,",
    "but the codemode backend runs JavaScript instead — see its",
    "description below before using it.",
    "",
    "Backends:",
    backendGuidance,
    "",
    `Default backend: ${JSON.stringify(opts.defaultBackend)}.`,
    "",
    "Use for builds, test runs, file manipulation, and `git`",
    "plumbing. Long output is truncated to keep tool replies small.",
  ].join("\n");

  const backendSchema = z
    .enum(backendIds as [string, ...string[]])
    .optional()
    .describe(
      [
        "Which backend to run on. Omit to use the default",
        `(${JSON.stringify(opts.defaultBackend)}). Set explicitly to route`,
        "the command elsewhere. Note the command language depends on",
        "the backend (see the per-backend descriptions).",
      ].join(" "),
    );

  const inputSchema = z.object({
    command: z
      .string()
      .describe(
        "The command to run. A shell line for the shell/container " +
          "backends (e.g. 'npm test'), or a JavaScript snippet for the " +
          "codemode backend (e.g. 'return await state.readFile(\"/workspace/x\")').",
      ),
    cwd: z.string().optional().describe("Working directory. Defaults to the workspace root."),
    backend: backendSchema,
  });

  return tool({
    description,
    inputSchema,
    // Must stay a pure function of the input. The AI SDK re-runs it
    // when a paused turn resumes and downgrades an approved call to a
    // denial if the answer has changed since the pause.
    needsApproval: ({ command, backend }) =>
      opts.policy != null &&
      decideApproval({ command, backend: backend ?? opts.defaultBackend }, opts.policy)
        .needsApproval,
    execute: async ({ command, cwd, backend }) => {
      const handle = await opts.workspace.shell.exec(command, {
        cwd,
        encoding: "utf8",
        backend,
      });
      const result = await handle.result();
      const record: ExecRecord = {
        command,
        cwd: cwd ?? null,
        backend: backend ?? opts.defaultBackend,
        exitCode: result.exitCode,
        stdout: truncate(result.stdout, maxBytes),
        stderr: truncate(result.stderr, maxBytes),
      };
      opts.onExec?.(record);
      return record;
    },
  });
}

function truncate(value: string, maxBytes: number): string {
  if (!value) return value;
  // Approximate bytes via length; UTF-8 worst case overcounts but
  // never undercounts, which is what we want for a soft cap.
  if (value.length <= maxBytes) return value;
  return `${value.slice(0, maxBytes)}\n\n[truncated, ${value.length - maxBytes} more bytes]`;
}
