/**
 * The agent, and the three places the policy meets the workspace.
 *
 * The whole example turns on one line, in `execTool` below:
 *
 *     writable: (input) => decideApproval(input, policy).needsApproval
 *
 * which reads backwards until you notice when it runs. The AI SDK only
 * calls a tool's `execute` after approval has been granted, so a
 * command that needed approval and reached `execute` is a command a
 * human said yes to. Driving `writable` off the same predicate as the
 * approval therefore says exactly this:
 *
 *     a command runs with write access  ⇔  a human approved it
 *
 * Everything else in this file exists to keep that true for callers
 * that are not the model, and to leave a record of what happened.
 *
 * The three seams, and what each is for:
 *
 *   toolApproval   Decides whether the turn pauses for a human. This
 *                  is the only one of the three that can ask a
 *                  question, because it is the only one that runs
 *                  before the command exists as an action.
 *
 *   writable       Decides what the command may do. Withholding it is
 *                  what makes a wrong guess survivable, and it is
 *                  enforced by the filesystem rather than by anything
 *                  in this file.
 *
 *   gate           The last word, for every caller. The tool layer
 *                  covers the model's path only; the gate also sees
 *                  the HTTP routes in src/index.ts and anything added
 *                  later. It cannot ask a human — by the time an
 *                  action exists there is nowhere to suspend it — so
 *                  it narrows instead of asking.
 *
 * And the audit hook, which decides nothing and records everything.
 */

import type {
  AuditOutcome,
  WorkspaceAction,
  WorkspaceAudit,
  WorkspaceGate,
} from "@cloudflare/computer";
import {
  createAITools,
  createExecTool,
  type ExecToolInput,
  type ExecWorkspaceLike,
} from "@cloudflare/computer/tools";
import type { ToolSet } from "ai";

import { type ApprovalPolicy, DEFAULT_APPROVAL_POLICY, decideApproval } from "./approval-policy.js";

/** The backend a command runs on when the model names none. */
export const DEFAULT_BACKEND = "worker-shell";

/**
 * What the model is told about each backend. Written to be chosen
 * between: the model picks a backend from these descriptions, and the
 * policy then decides what that choice costs in human attention.
 */
export const EXEC_BACKENDS = {
  "worker-shell": {
    description:
      "just-bash in a Dynamic Worker. Cold-starts fast, no container, no public network. " +
      "Covers cat, ls, grep, find, head, tail, sort, wc, diff, and git plumbing. " +
      "Cannot run npm, node, python, or any binary outside just-bash's built-in command set. " +
      "Recognized read-only commands run here without interrupting the user, so prefer it for " +
      "anything you are only inspecting.",
  },
  "worker-javascript": {
    description:
      "An ECMAScript module evaluated in a Dynamic Worker, with the workspace on node:fs. " +
      "Use it for computation over files that would be awkward as a shell pipeline. " +
      "Every module needs the user's approval before it runs.",
  },
  "container-shell": {
    description:
      "computerd in a Cloudflare Container: a full Linux userland with real coreutils, node, " +
      "npm, and public network access. Use it when the lighter backends cannot run the " +
      "command. Every command needs the user's approval before it runs, so reach for it last.",
  },
} as const;

export const SYSTEM_PROMPT = [
  "You are an assistant working in a Cloudflare Workspace rooted at /workspace.",
  "",
  "Tools:",
  "  - read, ls: inspect the tree. Prefer these over `exec cat` and `exec ls`.",
  "  - exec:     run a command on one of three backends. Start with the",
  "              default worker-shell backend and move to a heavier one only",
  "              when it cannot run what you need.",
  "",
  "Three things about exec are worth understanding, because they change how you",
  "should read a failure.",
  "",
  "First, some commands pause the turn while the user approves them. That is",
  "normal and not an error. Commands that are recognizably read-only on the",
  "worker-shell backend run without asking; everything else asks.",
  "",
  "Second, a command that ran without approval ran without write access, and",
  "its writes fail with EROFS or a read-only error. The result tells you which",
  "case you are in: it carries a `writable` field. If a command failed on a",
  "write while `writable` was false, do not retry it unchanged and do not work",
  "around it — say what you were trying to change and let the user decide.",
  "Retrying the same command verbatim will fail the same way.",
  "",
  "Third, on the container-shell backend a command without write access still",
  "appears to succeed: it writes to the container's own copy of the files and",
  "exits zero, and the changes are discarded when they are pulled back. A",
  "`discardedWrites` field on the result means exactly that happened. Treat it",
  "as a failure however good the exit code looks, report which paths were lost,",
  "and do not claim the work is done.",
  "",
  "Keep replies concise. Read files rather than guessing at their contents.",
].join("\n");

export interface AgentToolOptions {
  workspace: ExecWorkspaceLike & Parameters<typeof createAITools>[0]["workspace"];
  policy?: ApprovalPolicy;
  /** Notified for every exec, so a caller can log or display it. */
  onExec?: (record: { command: string; backend: string; writable: boolean }) => void;
}

/**
 * The model's toolset.
 *
 * Read and list are handed over freely; every mutation goes through
 * `exec`. That is deliberate. The write and edit tools in
 * `createAITools` would let the model change files without any of this
 * ever being consulted, and an example that asks carefully about `find
 * -delete` while a `write` tool sits unguarded next to it is telling
 * the reader something false about where the boundary is. One door.
 */
export function createAgentTools(options: AgentToolOptions): ToolSet {
  const policy = options.policy ?? DEFAULT_APPROVAL_POLICY;

  const tools = createAITools({ workspace: options.workspace, readonly: true });

  tools.exec = createExecTool({
    workspace: options.workspace,
    backends: EXEC_BACKENDS,
    defaultBackend: DEFAULT_BACKEND,

    // The line the example is about. `execute` runs only once approval
    // has been granted, so asking for write access exactly when
    // approval was required is what ties the capability to the human.
    //
    // Note which way this fails. The matcher calling a write a read
    // costs the command its write access, and it fails visibly with
    // EROFS instead of writing. The matcher calling a read a write
    // costs somebody a question. Neither outcome loses a file, which
    // is the only reason a heuristic is allowed near this decision.
    writable: (input: ExecToolInput) => {
      const writable = decideApproval(
        { command: input.command, backend: input.backend },
        policy,
      ).needsApproval;
      options.onExec?.({ command: input.command, backend: input.backend, writable });
      return writable;
    },
  });

  return tools;
}

/**
 * The `toolApproval` entry for `streamText`.
 *
 * Must stay a pure function of the input. The SDK re-runs it when a
 * paused turn resumes, and an approved call whose answer has since
 * changed is converted into a denial — so anything time-dependent here
 * would make approvals decay on their own.
 */
export function execApproval(policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY) {
  return (input: { command: string; backend?: string }) =>
    decideApproval({ command: input.command, backend: input.backend ?? DEFAULT_BACKEND }, policy)
      .needsApproval
      ? ("user-approval" as const)
      : ("not-applicable" as const);
}

/**
 * A gate over every caller, not just the model's.
 *
 * This is not a second copy of the approval decision, and it is worth
 * being clear about what it is instead. It cannot ask anybody
 * anything: a gate runs once the action exists, and there is nowhere
 * to suspend a running command that does not risk a partial result.
 * What it can do is refuse write access that nothing upstream
 * justified.
 *
 * So it checks the invariant rather than re-deriving the decision. A
 * command holding write access should be a command the matcher would
 * have raised a question about, because that is the only route to
 * write access through the tool layer. If a command that the matcher
 * calls a plain read turns up asking for write access anyway, then it
 * did not come through that route — a new caller, or an edited
 * resolver — and it is narrowed back to read-only. Narrowing costs
 * that caller nothing it needed: the matcher just said the command
 * only reads.
 *
 * Filesystem actions are allowed through. Nothing the model can call
 * reaches them, and the HTTP routes that do are how the workspace gets
 * seeded in the first place. They are still audited.
 */
export function createApprovalGate(
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): WorkspaceGate {
  return {
    check(action: WorkspaceAction) {
      // Switch on the kind rather than assuming: an action kind added
      // to the seam later should stay permitted rather than break a
      // caller that was never asked about it.
      if (action.kind !== "shell.exec") return { allow: true };
      if (!action.writable) return { allow: true };

      const decision = decideApproval(
        { command: action.command, backend: action.backend ?? DEFAULT_BACKEND },
        policy,
      );
      if (decision.needsApproval) return { allow: true };

      return { allow: true, writable: false };
    },
  };
}

/** One line of the audit trail. */
export interface AuditRecord {
  at: number;
  kind: WorkspaceAction["kind"];
  /** The command, for an exec; the path, for a filesystem action. */
  target: string;
  status: AuditOutcome["status"];
  writable?: boolean;
  detail?: string;
}

/**
 * An audit hook that keeps the last `limit` records and hands each one
 * to `sink` as it happens.
 *
 * It decides nothing, and it is not allowed to. The seam swallows what
 * this throws, on the grounds that the action has already happened and
 * failing a caller over a lost log line would quietly turn the audit
 * hook into a gate. The ring buffer is bounded for the same reason a
 * log is not a database: this is here to be read while the example is
 * running, not to be the record of authority.
 */
export function createAudit(options: {
  limit?: number;
  sink?: (record: AuditRecord) => void;
}): WorkspaceAudit & { records(): AuditRecord[] } {
  const limit = options.limit ?? 100;
  const ring: AuditRecord[] = [];

  return {
    record(action: WorkspaceAction, outcome: AuditOutcome) {
      const entry: AuditRecord = {
        at: Date.now(),
        kind: action.kind,
        target: action.kind === "shell.exec" ? action.command : action.path,
        status: outcome.status,
        writable: outcome.status === "allowed" ? outcome.writable : undefined,
        detail:
          outcome.status === "denied"
            ? outcome.reason
            : outcome.status === "failed"
              ? describe(outcome.error)
              : undefined,
      };
      ring.push(entry);
      if (ring.length > limit) ring.shift();
      options.sink?.(entry);
    },
    records() {
      return [...ring];
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
