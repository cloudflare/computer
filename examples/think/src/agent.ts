/**
 * TriageAgent — a Think Durable Object that owns one triage turn.
 *
 * Wiring:
 *   - super(state, env) hands us Agent + Think machinery (message
 *     store, agentic loop, workflow integration).
 *   - We additionally own a `@cloudflare/workspace.Workspace` backed
 *     by a Cloudflare Container running `wsd`. Mirrors the pattern
 *     in examples/container.
 *   - Think's own `workspace` field expects a string-based
 *     `WorkspaceLike` for its built-in workspace tools. We satisfy
 *     it with a small adapter over the container workspace and turn
 *     off `workspaceBash` because we expose our own `exec` tool.
 *     We also shadow Think's `read`/`write`/`edit` tool names with
 *     our vendored fs-tools (their streaming/byte-cap behaviour is
 *     friendlier for this example).
 *
 * Phase model:
 *   - The workflow flips `phase` via `setPhase("explore" | "structure")`
 *     before each `step.do` / `step.prompt`. "explore" exposes the
 *     full toolset (read/write/edit/exec/ls/report_update);
 *     "structure" hides every tool so the AI-SDK structured-output
 *     path doesn't fight the agentic loop. The phase is persisted to
 *     durable storage so a recovered turn keeps the right tools.
 */

import type { StepContext, WorkspaceLike as ThinkWorkspaceLike } from "@cloudflare/think";
import { Think } from "@cloudflare/think";
import {
  type DurableObjectStorageLike,
  R2Bucket,
  Workspace,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type WorkspaceStub,
} from "@cloudflare/workspace";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/workspace/backends/container";
import { WorkerBackend } from "@cloudflare/workspace/backends/worker";
import { type ToolSet, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { createExecTool } from "./tools/exec.js";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
  type WorkspaceLike as FsWorkspaceLike,
  WorkspaceFileStore,
} from "./tools/fs/index.js";
import { createReportUpdateTool } from "./tools/report-update.js";
import { createShareTool } from "./tools/share.js";

// Re-export so the runtime can build loopback bindings the DO
// uses: WorkspaceProxy carries container egress traffic back to
// this DO (the wsd /ws upgrade lands here), WorkspaceServiceProxy
// is the Fetcher the worker backend hands into its Dynamic Worker
// so the in-isolate shell can reach back to getWorkspace().
export { WorkspaceProxy, WorkspaceServiceProxy };

/**
 * Per-turn phase. The workflow flips this before each model step:
 *
 *   - "explore":   full toolset (read + write + edit + exec + ls +
 *                 report_update). The agent decides whether to attempt
 *                 a fix or just gather findings, depending on how
 *                 big the change looks. Git operations (clone, diff,
 *                 status) run through `exec` on the shell backend,
 *                 which registers a built-in `git` command that
 *                 forwards to the host's `workspace.git.cli(...)`.
 *   - "structure": no tools at all — used by the workflow's tool-less
 *                 `step.prompt` that coerces the explore turn's text
 *                 into the final zod schema. The structured-output
 *                 AI-SDK path is incompatible with tool calls on
 *                 Workers AI, so we hide them.
 */
export type TriagePhase = "explore" | "structure";

/**
 * Outcome of `runAgentTurn`. Folded out of `inspectSubmission` so the
 * workflow can decide whether to keep going or bail out gracefully.
 *
 *   - `ok`            normal completion with a non-empty assistant text.
 *   - `out-of-steps`  Think stopped on `stepCountIs(maxSteps)` mid-loop;
 *                     no final text was emitted.
 *   - `failed`        underlying submission ended in error/aborted/
 *                     skipped — typically a context-window overflow
 *                     on Workers AI. `reason` carries the detail.
 */
export interface AgentTurnResult {
  status: "ok" | "out-of-steps" | "failed";
  text: string;
  /** Empty string on `ok`; populated for `out-of-steps` / `failed`. */
  reason: string;
}

export interface TriageContext {
  issueUrl: string;
  webhookUrl: string;
  /**
   * When true, every assistant text part, tool call, and tool result
   * is POSTed to the webhook as a `{ type: "debug" }` event. Off by
   * default; the workflow only flips it when the caller asked for
   * it via the original /issue payload.
   */
  debug: boolean;
}

const CONTEXT_KEY = "triage-context";
const PHASE_KEY = "triage-phase";

const REPO_ROOT = "/workspace/repo";
const MODEL_ID = "@cf/moonshotai/kimi-k2.6";

// Anchor Think's generic before the mixin so withWorkspaceContainer
// sees a concrete constructor.
class TriageBase extends Think<Env> {}

export class TriageAgent extends withWorkspaceContainer(TriageBase) {
  /**
   * Off. The workflow is the durable layer here — `step.do` and
   * `step.prompt` replay deterministically through any DO eviction,
   * and `submitMessages` is keyed by an idempotent submissionId so a
   * replayed `runAgentTurn` reuses the prior turn's row rather than
   * starting over. Leaving Think's per-turn chat recovery on top of
   * that just spams `_chatRecoveryContinue timed out waiting for
   * stable state` when an upstream call (a Workers AI 502, a Kimi
   * context overflow) wedges a turn in a non-terminal state — the
   * recovery loop has nothing useful to do, there is no human
   * watching transient chat state, and the workflow's own retry is
   * the right replay boundary for this design.
   */
  override chatRecovery = false;

  /** Plenty of budget for a triage + fix + verify loop. */
  override maxSteps = 40;

  /** We have a dedicated `exec` tool; skip Think's bash. */
  override workspaceBash = false;

  /**
   * Two backends on a single Workspace:
   *
   *   - "shell" (default) is the WorkerBackend, just-bash in a
   *     Dynamic Worker. Instant boot, broad textual tooling,
   *     no container. The exec tool reaches this first.
   *   - "container" is the CloudflareContainerBackend, wsd over
   *     capnweb. Full Linux userland; the agent falls through
   *     to it when the shell can't run the command (network
   *     binaries like `npm install`, native dependencies, ...).
   *
   * The first backend in the list is the workspace default;
   * `shell.exec(command, { backend: "container" })` routes a
   * specific call elsewhere.
   */
  readonly #containerBackend: CloudflareContainerBackend;
  readonly #workspaceFs: Workspace;

  /** Cached context written by the Worker before the workflow runs. */
  #context: TriageContext | null = null;

  /** Current phase. `null` outside a workflow run. */
  #phase: TriagePhase | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const workspaceRef = { binding: "TriageAgent", id: ctx.id.toString() };
    this.#containerBackend = new CloudflareContainerBackend({
      id: "container",
      container: () => this,
      workspace: workspaceRef,
    });
    this.#workspaceFs = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends: [
        new WorkerBackend({
          id: "shell",
          loader: env.LOADER,
          workspace: workspaceRef,
          ctx,
        }),
        this.#containerBackend,
      ],
      // Mount the shared skills bucket at /workspace/.agents. The
      // R2 keys live under `.agents/` (e.g.
      // `.agents/skills/triage/SKILL.md`); the prefix is stripped
      // when computing the in-VFS path, so the agent reads
      // /workspace/.agents/skills/triage/SKILL.md. Read-only —
      // writes under the mount root reject with EROFS. Seed the
      // bucket once with `npm run seed:r2` to upload the bundled
      // triage skill.
      mounts: {
        "/workspace/.agents": R2Bucket(env.R2_SKILLS, { prefix: ".agents/" }),
      },
    });

    // Hand Think an adapter that satisfies its WorkspaceLike, so the
    // baseline read/write/edit tools have something to delegate to —
    // even though we shadow most of those names below. Think's
    // built-in tools land on the default backend (the shell).
    this.workspace = adaptToThinkWorkspace(this.#workspaceFs) as unknown as ThinkWorkspaceLike;

    this.ctx.blockConcurrencyWhile(async () => {
      this.#context = (await this.ctx.storage.get<TriageContext>(CONTEXT_KEY)) ?? null;
      this.#phase = (await this.ctx.storage.get<TriagePhase>(PHASE_KEY)) ?? null;
    });
  }

  // ── DO container surface ───────────────────────────────────────

  /** Forwarded by the Worker fetch handler for /ws upgrades. */
  override async fetch(request: Request): Promise<Response> {
    // Container upgrade path: pass directly to the backend. Anything
    // else falls through to the framework (Think + Agent inherit
    // their own request routing from agents-sdk).
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return this.#containerBackend.handleFetch(request);
    }
    return super.fetch(request);
  }

  /** Hand out a typed RPC stub to the workspace if a caller wants one. */
  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#workspaceFs.ready();
    return this.#workspaceFs.stub();
  }

  // ── Workflow control surface ──────────────────────────────────

  /** Called by the Worker once, right before kicking off the workflow. */
  async setContext(context: TriageContext): Promise<void> {
    this.#context = context;
    await this.ctx.storage.put(CONTEXT_KEY, context);
  }

  async getContext(): Promise<TriageContext | null> {
    return this.#context;
  }

  /** Called by the workflow inside a step.do before each step.prompt. */
  async setPhase(phase: TriagePhase): Promise<void> {
    this.#phase = phase;
    await this.ctx.storage.put(PHASE_KEY, phase);
  }

  /**
   * Worker → agent entry point. Schedules the workflow and tracks it
   * in the agent's runtime DB (provided by `Agent.runWorkflow`).
   */
  async startTriage(params: { issueUrl: string }): Promise<string> {
    if (!this.#context) {
      throw new Error("setContext() must be called before startTriage()");
    }
    await this.#workspaceFs.ready();
    return this.runWorkflow("TRIAGE_WORKFLOW", params);
  }

  /** Used by `notify-done` to POST the terminal payload. */
  async postWebhook(payload: {
    message: string;
    patch?: string;
    commit?: { subject: string; body: string };
  }): Promise<void> {
    const ctx = this.#context;
    if (!ctx) throw new Error("No triage context bound");
    await fetch(ctx.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Compute a unified diff between HEAD and the working tree, the
   * same way `git diff HEAD` would. Empty string means the agent
   * didn't change anything or HEAD can't be resolved (e.g. the agent
   * never cloned).
   *
   * Calls `workspace.git.diff` directly rather than going through
   * the shell backend's `git` command. The workflow needs the diff
   * text in-band to build the terminal webhook payload, and the
   * direct call skips a shell round trip.
   */
  async gitDiff(): Promise<string> {
    await this.#workspaceFs.ready();
    return this.#workspaceFs.git.diff({ dir: REPO_ROOT });
  }

  /**
   * Run one full Think turn with the model and the current phase's
   * tools available. Returns the assistant text the model produced
   * once the turn reaches a terminal state.
   *
   * This is the "exploration" half of the two-step pattern from
   * `docs/think/workflows.md`: do the work with tools here, then have
   * the workflow follow up with a tool-less `step.prompt` that just
   * coerces this turn's text into structured output. The two steps
   * run as separate Workflow steps so a crash between them replays
   * deterministically.
   *
   * Uses `submitMessages` (the same primitive `step.prompt` uses
   * under the hood) so the turn is durable and idempotent, then polls
   * `inspectSubmission` until terminal. We don't pass the workflow
   * metadata that `step.prompt` would attach — we want the result
   * back in-band, not via a Workflow event.
   */
  async runAgentTurn(prompt: string): Promise<AgentTurnResult> {
    const submission = await this.submitMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: prompt }],
      },
    ]);
    return this.#awaitAssistantText(submission.submissionId);
  }

  /**
   * Spin until the submission reaches a terminal status, then walk
   * `this.messages` back for the most recent assistant text.
   *
   * Three terminal shapes get folded into `AgentTurnResult` instead
   * of being thrown:
   *
   *   - `completed` + non-empty text  -> `{ status: "ok", text }`
   *   - `completed` + empty text       -> `{ status: "out-of-steps", text: "" }`
   *     (Think stopped on `stepCountIs(maxSteps)` mid-thought.)
   *   - `error` / `aborted` / `skipped` -> `{ status: "failed", text, reason }`
   *     (typical cause is Workers AI giving up on a context-window
   *     overflow; the SSE stream fails to parse, the submission is
   *     marked errored, and we capture whatever assistant text was
   *     produced before the cutoff.)
   *
   * The workflow checks `status` and short-circuits to `notify-done`
   * when the budget is exhausted, rather than wedging on a half-empty
   * structuring step.
   */
  async #awaitAssistantText(submissionId: string): Promise<AgentTurnResult> {
    const POLL_MS = 500;
    const MAX_MS = 30 * 60 * 1000; // 30 min hard ceiling.
    const start = Date.now();
    while (Date.now() - start < MAX_MS) {
      const insp = await this.inspectSubmission(submissionId);
      if (!insp) throw new Error(`Submission ${submissionId} vanished`);
      if (insp.status === "completed") {
        const text = collectAssistantText(this.messages);
        if (text.length > 0) return { status: "ok", text, reason: "" };
        return {
          status: "out-of-steps",
          text: "",
          reason:
            "Agent completed without emitting a final assistant text — likely hit the maxSteps budget mid-loop.",
        };
      }
      if (insp.status === "error" || insp.status === "aborted" || insp.status === "skipped") {
        return {
          status: "failed",
          text: collectAssistantText(this.messages),
          reason: `Agent turn ended in status=${insp.status}${insp.error ? `: ${insp.error}` : ""}`,
        };
      }
      await sleep(POLL_MS);
    }
    return {
      status: "failed",
      text: collectAssistantText(this.messages),
      reason: `Agent turn timed out after ${MAX_MS}ms`,
    };
  }

  // ── Think hooks ───────────────────────────────────────────────

  override getModel() {
    return createWorkersAI({ binding: this.env.AI })(MODEL_ID);
  }

  /**
   * Kimi K2.6 has a 262,144-token context window but the Workers AI
   * runtime caps generations at a small default (a few thousand
   * tokens) when `max_tokens` is unset — enough to truncate mid-
   * tool-call. Bump it to something that lets the model finish a
   * structured answer or a chain of tool calls.
   *
   * 16k is well under the 262k window and leaves plenty of room for
   * input — the workflow's prior tool calls + the system prompt
   * commonly run ~30–50k tokens by the time we hit the structure
   * phase, so the input dominates anyway.
   */
  override async beforeTurn() {
    return { maxOutputTokens: 16384 };
  }

  override getSystemPrompt(): string {
    const phase = this.#phase ?? "explore";
    if (phase === "structure") {
      return [
        "You are a JSON-shaping assistant. The user message contains a",
        "prior analysis the agent produced. Reply with structured",
        "output that matches the schema you were given. Do not invent",
        "new findings; only restructure what the prior turn already",
        "said. No tools are available in this phase.",
      ].join("\n");
    }
    return [
      "You are a triage assistant for a GitHub issue.",
      "",
      `Repository will be cloned into ${REPO_ROOT}.`,
      "",
      "Read /workspace/.agents/skills/triage/SKILL.md before you start.",
      "It captures the playbook you should follow and the exact shape",
      "of the summary you should produce.",
      "",
      "Tools available, in preference order. Reach for `exec` only",
      "when the dedicated tools can't do what you need:",
      "  - read, ls:      explore the working tree. Prefer these over",
      "                   `exec cat` / `exec ls`.",
      "  - write, edit:   modify files. Prefer these over `exec sed`",
      "                   / `exec tee` / shell heredocs.",
      "  - exec:          run shell commands. Use this for `git`",
      "                   (clone, status, diff, log) on the `shell`",
      "                   backend, and for the project's own tests /",
      "                   typecheck / build commands (npm test,",
      "                   vitest run, cargo test, go test, etc.) on",
      "                   the `container` backend. Do NOT use it for",
      "                   file I/O that `read` / `ls` / `write` /",
      "                   `edit` cover.",
      "  - report_update: progress updates back to the user.",
      "",
      "Git is built into the `shell` backend. Run",
      `  exec({ command: "git clone https://github.com/<owner>/<repo> ${REPO_ROOT}", backend: "shell" })`,
      "to populate the working tree, and `git status` / `git diff` /",
      "`git log` against the same backend to inspect it. The clone",
      "runs on the host durable object, so it works despite the",
      "shell isolate having no network of its own; only https://",
      "URLs are supported. Pass --depth=<N> if you need more history",
      "than the default depth=1.",
      "",
      "Workflow:",
      `  1. Clone the repo with \`git clone\` via \`exec\` on the`,
      `     \`shell\` backend into ${REPO_ROOT}.`,
      "     Read what you need to understand the bug.",
      "  2. Decide: is this a small, well-scoped change you can confidently",
      "     make in a handful of edits, with a way to verify it?",
      "       - YES  -> apply the minimal fix with `write` / `edit`, run the",
      "                project's own tests / typecheck via `exec` to confirm,",
      "                then describe the commit you made.",
      "       - NO   -> do not edit anything. Write up the findings: what",
      "                the bug is, the files most likely involved, and the",
      "                concrete next steps a human should take.",
      "  3. Use `report_update` a few times to keep the user posted. Keep",
      "     messages terse — one or two sentences. Do NOT say 'DONE'",
      "     yourself; the workflow emits the terminal message.",
      "",
      "When you are happy with the outcome, reply with a short natural-",
      "language summary covering:",
      "  - whether you attempted a fix (yes/no) and why",
      "  - a one-line imperative commit subject (even for findings-only,",
      "    treat it as 'investigate: …' or 'docs: …' so the workflow can",
      "    use it as the headline)",
      "  - one or two paragraphs of context (commit body / findings)",
      "  - the absolute paths of any files you edited (may be empty)",
      "  - the verification commands you ran, in order (may be empty)",
      "  - concrete next steps a human should take (may be empty if the",
      "    fix is complete)",
      "",
      "The workflow will compute the unified diff itself via `git diff",
      "HEAD`; you do not need to include it.",
    ].join("\n");
  }

  override getTools(): ToolSet {
    const ctx = this.#context;
    if (!ctx) return {} as ToolSet;

    const phase = this.#phase ?? "explore";
    if (phase === "structure") return {} as ToolSet;

    const store = new WorkspaceFileStore(adaptToFsWorkspace(this.#workspaceFs));
    const ws = this.#workspaceFs;
    return {
      // Per-tool caps. Kimi K2.6 has a 262k context window so we
      // don't need to be paranoid; the caps are mostly so a
      // pathological tool call (giant lockfile, multi-MB log) doesn't
      // burn through the input budget on a single turn. ~32 KiB ≈
      // ~8k tokens per read.
      read: createReadTool({ store, maxBytes: 32 * 1024, maxLines: 800 }),
      ls: createLsTool(ws),
      write: createWriteTool({ store }),
      edit: createEditTool({ store }),
      exec: createExecTool({
        workspace: ws,
        maxBytes: 32 * 1024,
        backends: {
          shell: {
            description:
              "just-bash in a Dynamic Worker. Cold-start fast, no " +
              "container, no public network. Good for cat / grep / " +
              "sed / awk / jq / head / tail / sort / find / file " +
              "inspection, quick text transformations, and `git` " +
              "(clone / status / diff / log / branch / commit) — " +
              "the shell registers a built-in `git` command that " +
              "forwards to the host workspace, so network-bound " +
              "subcommands like `git clone` work even though the " +
              "isolate itself has no public network. Cannot run " +
              "npm, node, python, or any binary that isn't part of " +
              "just-bash's built-in command set.",
          },
          container: {
            description:
              "Cloudflare Container running wsd over capnweb. Full " +
              "Linux userland: npm, node, the test runner, real " +
              "binaries on $PATH, public network. Cold start is much " +
              "slower (container boot); reach for it when the shell " +
              "backend can't run the command — typically `npm test`, " +
              "`npm install`, language-specific tooling, or anything " +
              "that needs a real Linux binary. For git itself, " +
              "prefer the shell backend.",
          },
        },
        defaultBackend: "shell",
      }),
      report_update: createReportUpdateTool({ webhookUrl: ctx.webhookUrl }),
      // Only offered when R2 S3 credentials are configured; the
      // bucket binding alone can't mint the presigned URL the tool
      // returns. Absent credentials, the agent simply has no share
      // tool rather than one that fails on every call.
      ...(this.env.R2_ACCESS_KEY_ID && this.env.R2_SECRET_ACCESS_KEY
        ? {
            share: createShareTool({
              workspace: ws,
              bucket: this.env.ASSETS,
              s3Bucket: "think-example-assets",
              env: this.env as unknown as Record<string, string | undefined>,
            }),
          }
        : {}),
    };
  }

  // ── Debug hooks ────────────────────────────────────────────────
  //
  // When `context.debug` is set, every tool call and every step's
  // assistant text gets POSTed to the webhook as a `type:"debug"`
  // event so the caller can watch the agent think. The terminal
  // notify-done payload is unchanged.
  //
  // Hooks used:
  //   afterToolCall  — fires once per tool execution.
  //   onStepFinish   — fires once per model round (a "step" in
  //                    AI-SDK terms). This is the right hook for
  //                    intermediate assistant text: between tool
  //                    calls the model often produces reasoning
  //                    or partial text, and onChatResponse only
  //                    fires at the very end of the whole
  //                    submission, so it skips everything in
  //                    between.

  override async afterToolCall(ctx: {
    toolName: string;
    toolCallId: string;
    durationMs: number;
    success: boolean;
    output?: unknown;
    error?: unknown;
  }): Promise<void> {
    if (!this.#context?.debug) return;
    this.#postDebug({
      kind: "tool-call",
      tool: ctx.toolName,
      toolCallId: ctx.toolCallId,
      durationMs: ctx.durationMs,
      success: ctx.success,
      ...(ctx.success ? { output: redact(ctx.output) } : { error: String(ctx.error) }),
    });
  }

  override async onStepFinish(ctx: StepContext): Promise<void> {
    if (!this.#context?.debug) return;
    const text = typeof ctx.text === "string" ? ctx.text.trim() : "";
    const reasoning = extractReasoning(ctx);
    const toolCalls = Array.isArray(ctx.toolCalls)
      ? ctx.toolCalls.map((c) => c.toolName).filter((n): n is string => typeof n === "string")
      : [];
    // Skip empty steps — pure-control steps with no text, no
    // reasoning, and no tool calls don't help the watcher.
    if (text.length === 0 && reasoning.length === 0 && toolCalls.length === 0) return;
    this.#postDebug({
      kind: "step",
      text,
      reasoning,
      toolCalls,
      finishReason: typeof ctx.finishReason === "string" ? ctx.finishReason : undefined,
    });
  }

  override async onChatResponse(_result: unknown): Promise<void> {
    if (!this.#context?.debug) return;
    // Submission boundary marker. Per-step content is emitted by
    // onStepFinish above; this just lets the CLI know the agent's
    // current submission has reached a terminal state.
    this.#postDebug({ kind: "submission-complete" });
  }

  #postDebug(payload: Record<string, unknown>): void {
    const ctx = this.#context;
    if (!ctx) return;
    // Fire-and-forget through waitUntil so a slow or unreachable
    // webhook doesn't stall the agent loop. afterToolCall and
    // onStepFinish are both awaited by Think before the next step
    // runs; inlining the POST would pin every step on the webhook's
    // RTT. The trade is no backpressure — fine for a debug stream,
    // not fine for the terminal notify-done payload (which still
    // awaits via postWebhook above).
    const body = JSON.stringify({ type: "debug", phase: this.#phase ?? "", ...payload });
    this.ctx.waitUntil(
      fetch(ctx.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
        .then((res) => {
          // Drain the body so the connection can be reused; the
          // CLI returns 204 with no payload, but other receivers
          // might.
          void res.body?.cancel();
        })
        .catch(() => {
          // Debug delivery is best-effort — don't crash a turn
          // over it. The error already happened off the critical
          // path; nothing useful to log inside the DO.
        }),
    );
  }
}

// ── Adapters ───────────────────────────────────────────────────────

/**
 * Bridge from `@cloudflare/workspace.Workspace` to the vendored
 * fs-tools' `WorkspaceLike` shape. The vendored tools only call into
 * `fs.{stat,readFile,writeFile,mkdir}`, which the container
 * workspace already exposes directly.
 */
function adaptToFsWorkspace(ws: Workspace): FsWorkspaceLike {
  return ws as unknown as FsWorkspaceLike;
}

/**
 * Bridge from `@cloudflare/workspace.Workspace` to Think's
 * string-shaped `WorkspaceLike`. Think only constructs the default
 * workspace tools lazily; nothing calls these methods unless the
 * model actually invokes a default tool, and our `getTools()`
 * shadows the names we care about. The adapters exist so the Think
 * baseline doesn't crash if it does fire.
 */
function adaptToThinkWorkspace(ws: Workspace) {
  return {
    async readFile(path: string): Promise<string | null> {
      try {
        return await ws.fs.readFile(path, "utf8");
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async readFileBytes(path: string): Promise<Uint8Array | null> {
      try {
        const stream = await ws.fs.readFile(path);
        return await drain(stream);
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async writeFile(path: string, content: string): Promise<void> {
      await ws.fs.writeFile(path, new TextEncoder().encode(content));
    },
    async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
      await ws.fs.mkdir(path, opts?.recursive ? { recursive: true } : {});
    },
    async rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> {
      await ws.fs.rm(path, {
        ...(opts?.recursive ? { recursive: true as const } : {}),
        ...(opts?.force ? { force: true as const } : {}),
      });
    },
    async stat(path: string) {
      try {
        const s = await ws.fs.stat(path);
        return {
          path,
          name: path.split("/").pop() ?? path,
          type: s.isDirectory ? ("directory" as const) : ("file" as const),
          size: s.size,
          modifiedAt: new Date(s.mtime),
          isDirectory: s.isDirectory,
          isFile: s.isFile,
        };
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async readDir(dir: string) {
      const entries = await ws.fs.readdir(dir);
      return entries.map((e) => ({
        path: `${dir}/${e.name}`,
        name: e.name,
        type: e.isDirectory ? ("directory" as const) : ("file" as const),
        size: 0,
        modifiedAt: new Date(0),
        isDirectory: e.isDirectory,
        isFile: e.isFile,
      }));
    },
    async glob(pattern: string) {
      // Cheap shim — full glob semantics aren't needed in this demo.
      // Think's built-in grep filters by `entry.type === "file"`, so
      // we have to stat each candidate to know whether it's a blob.
      // ws.fs.find already returns the type alongside the path, so
      // forward it directly instead of re-stat'ing. Without this,
      // every grep returned filesSearched: 0.
      const matches = await ws.fs.find("/workspace", pattern);
      return matches.map((m) => ({
        path: m.path,
        name: m.path.split("/").pop() ?? m.path,
        type: m.type === "dir" ? ("directory" as const) : ("file" as const),
        size: 0,
        modifiedAt: new Date(0),
        isDirectory: m.type === "dir",
        isFile: m.type === "file",
      }));
    },
  };
}

function isEnoent(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "ENOENT") return true;
  return typeof e.message === "string" && /ENOENT|no such/i.test(e.message);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

// ── A small `ls` tool: vendored fs-tools don't include it. ─────────

function createLsTool(ws: Workspace) {
  return tool({
    description:
      "List the immediate children of a workspace directory. Returns " +
      "names with their type (file/dir). One level only.",
    inputSchema: z.object({
      path: z.string().describe("Absolute directory path."),
    }),
    execute: async ({ path }) => {
      const entries = await ws.fs.readdir(path);
      return {
        path,
        entries: entries.map((e) => ({
          name: e.name,
          type: e.isDirectory ? "dir" : "file",
        })),
      };
    },
  });
}

// ── Small helpers ─────────────────────────────────────────────────────────────

/**
 * Walk a UIMessage[] back to front, find the most recent assistant
 * message, and join its visible text parts. Reasoning parts and tool
 * parts are dropped — the structuring step / debug stream only care
 * about the model's natural-language response.
 */
/**
 * Pull a flat reasoning string out of a StepContext. Providers vary:
 * some expose `reasoning` as a single string, some as an array of
 * `{ type: "reasoning", text }` parts, some put the same content on
 * `reasoningText`. We coalesce all three shapes into one string and
 * leave the consumer to decide whether to print it.
 */
function extractReasoning(ctx: unknown): string {
  const record = ctx as { reasoning?: unknown; reasoningText?: unknown };
  const raw = record.reasoning ?? record.reasoningText ?? "";
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((r) => {
        if (typeof r === "string") return r;
        if (r && typeof r === "object" && typeof (r as { text?: unknown }).text === "string") {
          return (r as { text: string }).text;
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function collectAssistantText(
  messages: ReadonlyArray<{ role: string; parts: Array<{ type: string; text?: string }> }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = m.parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truncate huge tool outputs so a chatty `exec` doesn't blow the
 * webhook receiver up. We don't try to be clever about structure;
 * the debug stream is a development aid, not a transcript.
 */
function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > 4000
      ? `${value.slice(0, 4000)}… [truncated, ${value.length - 4000} more chars]`
      : value;
  }
  if (typeof value === "object") {
    try {
      const s = JSON.stringify(value);
      if (s.length <= 4000) return value;
      return `[object too large for debug: ${s.length} chars]`;
    } catch {
      return "[unserialisable]";
    }
  }
  return value;
}
