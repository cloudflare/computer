/**
 * The optional agent layer.
 *
 * This module is deliberately separate from the durable object that
 * owns the workspace. The workspace is just a filesystem with a few
 * backends; nothing about it depends on a model. `runAgentTurn`
 * bolts a model loop on top: it builds the `exec` tool over a
 * workspace handle (a live Workspace or a stub — either works) and
 * runs one agentic turn.
 *
 * Because the loop only needs a handle that exposes `shell.exec`,
 * the agent can run anywhere: here it runs inside the Worker fetch
 * handler and reaches the workspace through its stub, so the
 * workspace durable object never has to know an agent exists.
 *
 * A turn can end in one of two ways. Either the model finishes, or it
 * asks to run a command the approval policy holds back — in which case
 * the turn returns `awaiting-approval` along with the message history
 * needed to pick it up again. Nothing about that history lives here:
 * `runAgentTurn` is one `generateText` call inside a fetch handler and
 * is over when it returns. Whoever calls it is responsible for storing
 * a paused turn and handing it back on resume, which in this example
 * is the `AgentSession` durable object.
 */

import { generateText, type LanguageModel, type ModelMessage, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import { type ApprovalPolicy, DEFAULT_APPROVAL_POLICY, decideApproval } from "./approval-policy.js";
import { createExecTool, type ExecWorkspaceLike } from "./tools/exec.js";

// The Workers AI model that drives the loop. Kimi K2.6 handles tool
// calling and has a large context window.
const MODEL_ID = "@cf/moonshotai/kimi-k2.6";

// Plenty of budget for a write-then-read loop, with a ceiling so a
// confused model can't spin forever. Spent across every pass of a
// turn, not per pass, so waiting for a human doesn't buy the model a
// fresh allowance.
export const MAX_STEPS = 12;

/** A human's answer to one approval request. */
export interface ApprovalResponse {
  approvalId: string;
  approved: boolean;
  /** Shown to the model when a command is denied. */
  reason?: string;
}

/** A command the model wants to run, held back for a human. */
export interface PendingApproval {
  /** Identifies this request when the answer arrives. */
  approvalId: string;
  toolCallId: string;
  backend: string;
  command: string;
  cwd: string | null;
  /** Why the policy stopped it, in one line. */
  reason: string;
}

export interface AgentTurnOptions {
  env: Env;
  workspace: ExecWorkspaceLike;
  /** The user's request. Omit when resuming a paused turn. */
  prompt?: string;
  /** Pick up a turn that paused, given a human's answers. */
  resume?: {
    /** The `messages` a previous pass returned. */
    messages: ModelMessage[];
    /** One entry per approval the paused pass requested. */
    approvals: ApprovalResponse[];
  };
  /** Which commands need a human. Defaults to the example's policy. */
  policy?: ApprovalPolicy;
  /** Steps earlier passes of this turn already spent. */
  stepsUsed?: number;
  /**
   * The model to drive the loop with. Defaults to Workers AI; tests
   * inject a scripted model so the loop can be exercised without a
   * model round trip.
   */
  model?: LanguageModel;
}

export interface AgentToolCall {
  backend: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AgentTranscript {
  /**
   * `awaiting-approval` means the model asked for a command the policy
   * holds back, nothing further ran, and the turn is resumable.
   */
  status: "completed" | "awaiting-approval";
  text: string;
  finishReason: string;
  /** Model steps this pass took. */
  steps: number;
  /** Model steps the whole turn has taken. */
  stepsUsed: number;
  /** Commands this pass ran. */
  toolCalls: AgentToolCall[];
  pendingApprovals: PendingApproval[];
  /**
   * The turn's history so far, for storing against a resume. Server
   * side only — it carries the whole conversation and is not something
   * to hand a client.
   */
  messages: ModelMessage[];
}

const SYSTEM_PROMPT = [
  "You are an agent working inside a workspace with a filesystem",
  "mounted at /workspace. You act on the files only through the",
  "`exec` tool.",
  "",
  "The `exec` tool exposes three backends. Read its per-backend",
  "descriptions and pick the one that fits each command:",
  "",
  "- shell: a fast shell for text tools and git.",
  "- codemode: runs JavaScript against the files through a state.*",
  "  namespace. Use it when a task is easiest expressed as code,",
  "  for example reading a file and returning its contents, or",
  "  computing a value and writing it out. The /workspace directory",
  "  may not exist yet, so create it first with",
  '  `await state.mkdir("/workspace", { recursive: true })`.',
  "- container: a full Linux userland for real binaries; slow to",
  "  boot, so reach for it only when the lighter backends can't run",
  "  the command.",
  "",
  "Some commands need a human's approval before they run. When one",
  "does, the turn stops and resumes after a person answers; you do",
  "not need to do anything differently. If a command comes back as",
  "denied, do not try to run it again on another backend — say what",
  "you were not allowed to do and stop.",
  "",
  "When the task is done, reply with a short plain-text summary of",
  "what you did.",
].join("\n");

export async function runAgentTurn(opts: AgentTurnOptions): Promise<AgentTranscript> {
  if (opts.prompt == null && opts.resume == null) {
    throw new Error("runAgentTurn: pass either a prompt or a turn to resume");
  }

  const model = opts.model ?? createWorkersAI({ binding: opts.env.AI })(MODEL_ID);
  const policy = opts.policy ?? DEFAULT_APPROVAL_POLICY;
  const defaultBackend = "shell";

  // Every command this pass runs, collected as it happens. See
  // `onExec` on the tool for why the steps aren't enough.
  const toolCalls: AgentToolCall[] = [];

  const exec = createExecTool({
    workspace: opts.workspace,
    maxBytes: 16 * 1024,
    policy,
    onExec: (record) => {
      toolCalls.push({
        backend: record.backend,
        command: record.command,
        exitCode: record.exitCode,
        stdout: record.stdout,
        stderr: record.stderr,
      });
    },
    backends: {
      shell: {
        description:
          "just-bash in a Dynamic Worker. Cold-start fast, no " +
          "container, no public network. Good for cat / grep / sed / " +
          "awk / head / tail / sort / find and `git`. `command` is a " +
          "shell line. Cannot run npm, node, python, or any binary " +
          "outside just-bash's built-in command set.",
      },
      codemode: {
        description:
          "Runs JavaScript in a Dynamic Worker. `command` is a " +
          "JavaScript snippet, not a shell line. It reaches the " +
          "workspace files through an async `state.*` namespace. " +
          "Reads: state.readFile(path) (utf8), state.readFileBytes(path) " +
          "(Uint8Array), state.stat(path), state.lstat(path), " +
          "state.exists(path), state.readlink(path), state.readdir(path), " +
          "state.find(dir, glob?), state.ls(prefix), " +
          "state.grep(pattern, path, { ignoreCase }). Mutations: " +
          "state.writeFile(path, data), state.mkdir(path, { recursive }), " +
          "state.rm(path, { recursive, force }), state.chmod(path, mode), " +
          "state.symlink(target, path). The snippet's return value and any " +
          "console.log output become stdout; a thrown error becomes " +
          "stderr with exit code 1. Use for file work and logic that " +
          "reads cleanly as code.",
      },
      container: {
        description:
          "Cloudflare Container running wsd. Full Linux userland: " +
          "npm, node, real binaries on PATH, public network. " +
          "`command` is a shell line. Cold start is slow (container " +
          "boot); reach for it only when shell can't run the command.",
      },
    },
    defaultBackend,
  });

  // A new turn starts from the prompt; a resumed one replays the
  // history it paused with and appends the human's answers as a tool
  // message. The AI SDK reads approval responses from the last message
  // only, which is why they go in one message together.
  const messages: ModelMessage[] =
    opts.resume != null
      ? [
          ...opts.resume.messages,
          {
            role: "tool",
            content: opts.resume.approvals.map((approval) => ({
              type: "tool-approval-response" as const,
              approvalId: approval.approvalId,
              approved: approval.approved,
              ...(approval.reason != null ? { reason: approval.reason } : {}),
            })),
          },
        ]
      : [{ role: "user", content: opts.prompt as string }];

  const stepsAlreadyUsed = opts.stepsUsed ?? 0;
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    messages,
    tools: { exec },
    // At least one step, so a turn that has exhausted its budget still
    // reports back rather than failing.
    stopWhen: stepCountIs(Math.max(1, MAX_STEPS - stepsAlreadyUsed)),
  });

  const lastStep = result.steps.at(-1);

  // The pass paused if the model asked for anything the policy holds
  // back. Those calls did not run.
  const pendingApprovals: PendingApproval[] = [];
  for (const part of lastStep?.content ?? []) {
    if (part.type !== "tool-approval-request") continue;
    const input = part.toolCall.input as { command: string; cwd?: string; backend?: string };
    const backend = input.backend ?? defaultBackend;
    pendingApprovals.push({
      approvalId: part.approvalId,
      toolCallId: part.toolCall.toolCallId,
      backend,
      command: input.command,
      cwd: input.cwd ?? null,
      // The AI SDK's gate answers yes or no; ask the policy again for
      // the wording a human should see. Same inputs, same answer.
      reason: decideApproval({ command: input.command, backend }, policy).reason,
    });
  }

  return {
    status: pendingApprovals.length > 0 ? "awaiting-approval" : "completed",
    text: result.text,
    finishReason: result.finishReason,
    steps: result.steps.length,
    stepsUsed: stepsAlreadyUsed + result.steps.length,
    toolCalls,
    pendingApprovals,
    // The history to store against a resume: what went in, plus what
    // the model and the tools produced on the way out.
    messages: [...messages, ...(lastStep?.response.messages ?? [])],
  };
}
