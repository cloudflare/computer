import {
  type DurableObjectStorageLike,
  Workspace,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type WorkspaceStub,
} from "@cloudflare/computer";
import { CloudflareContainerBackend } from "@cloudflare/computer/backends/container";
import {
  WorkerShellBackend,
  type WorkerShellBackendOptions,
} from "@cloudflare/computer/backends/worker-shell";
import { getSandbox, type Sandbox as SandboxDO } from "@cloudflare/sandbox";
import { type ChunkContext, type StepContext, Think } from "@cloudflare/think";
import type { ToolSet } from "ai";
import { getServerByName } from "partyserver";
import type { ExecutionTarget, RunEventKind, RuntimeId } from "../../shared/events";
import type { ComparisonFixture, FixtureFile } from "../../shared/fixture";
import {
  type ContainerWarmPoolHandle,
  type ContainerWarmPoolNamespace,
  containerSleepAfter,
  getWarmPoolHandle,
  type WorkspaceContainerHost,
} from "../container-pools";
import type { CompareRun } from "../index";
import {
  createSandboxRuntimeAdapter,
  createWorkspaceRuntimeAdapter,
  type RuntimeAdapter,
} from "../runtime/adapter";
import {
  createSandboxCommandRunner,
  createSandboxFileStore,
  createSandboxFixtureRuntime,
} from "../runtime/sandbox";
import { seedFixture } from "../runtime/seed";
import {
  createWorkspaceCommandRunner,
  createWorkspaceFileStore,
  createWorkspaceFixtureRuntime,
} from "../runtime/workspace";
import { createRuntimeThinkModel } from "./model";
import { createRuntimeSystemPrompt } from "./prompts";
import { runRealThinkTurn } from "./real-turn";
import { type CompareRunEventSink, createRemoteRunEventRecorder } from "./remote-recorder";
import { createRuntimeThinkTools, type RuntimeThinkToolRecorder } from "./runtime-tools";

export { WorkspaceProxy, WorkspaceServiceProxy };

export interface RuntimeThinkAgentEnv {
  AI: Ai;
  CompareRun: DurableObjectNamespace<CompareRun>;
  Sandbox: DurableObjectNamespace<SandboxDO>;
  SandboxWarmPool: ContainerWarmPoolNamespace;
  WorkspaceContainerHost: DurableObjectNamespace<WorkspaceContainerHost>;
  WorkspaceWarmPool: ContainerWarmPoolNamespace;
  CONTAINER_SLEEP_AFTER?: string;
  FUSE_MOUNT?: string;
  LOADER: WorkerShellBackendOptions["loader"];
  WARM_POOL_RESET_KEY?: string;
}

interface RunConfig {
  runId: string;
  fixture: ComparisonFixture;
}

abstract class RuntimeThinkAgent extends Think<RuntimeThinkAgentEnv> {
  #activeRecorder: RuntimeThinkToolRecorder | null = null;
  #messageDelta = "";
  #preparedTools: ToolSet | null = null;
  #thinkingDelta = "";

  override chatRecovery = false;

  abstract readonly runtime: RuntimeId;
  abstract readonly runtimeLabel: "Workspace" | "Sandbox";

  constructor(ctx: DurableObjectState, env: RuntimeThinkAgentEnv) {
    super(ctx, env);
    this.maxSteps = Number.POSITIVE_INFINITY;
  }

  protected abstract runWithRuntime(
    config: RunConfig,
    recorder: RuntimeThinkToolRecorder,
  ): Promise<void>;

  override getModel() {
    return createRuntimeThinkModel(this.env.AI);
  }

  override getSystemPrompt(): string {
    return createRuntimeSystemPrompt(this.runtime);
  }

  async runComparison(config: RunConfig): Promise<void> {
    const compareRun = (await getServerByName(
      this.env.CompareRun,
      config.runId,
    )) as unknown as CompareRunEventSink;
    const recorder = createRemoteRunEventRecorder(compareRun);
    await this.runWithRuntime(config, recorder);
  }

  async cancelComparison(): Promise<void> {
    this.cancelAllChats();
  }

  protected async runThinkTurn(
    adapter: RuntimeAdapter,
    recorder: RuntimeThinkToolRecorder,
    fixture: ComparisonFixture,
  ): Promise<void> {
    this.#activeRecorder = recorder;
    this.#messageDelta = "";
    this.#thinkingDelta = "";
    this.#preparedTools = createRuntimeThinkTools({ adapter, recorder }) as unknown as ToolSet;

    try {
      await runRealThinkTurn({
        adapter,
        recorder,
        fixture,
        invoke: ({ prompt }) => this.invokeThink(prompt),
      });
      await this.#flushStreamingDeltas();
    } finally {
      this.#activeRecorder = null;
      this.#messageDelta = "";
      this.#thinkingDelta = "";
    }
  }

  override getTools(): ToolSet {
    return this.#preparedTools ?? ({} as ToolSet);
  }

  async invokeThink(prompt: string): Promise<{ text: string }> {
    const submission = await this.submitMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: prompt }],
      },
    ]);

    return { text: await this.awaitAssistantText(submission.submissionId) };
  }

  override async onChunk(ctx: ChunkContext): Promise<void> {
    const chunk = ctx.chunk as { type?: string; text?: unknown; delta?: unknown };
    const text =
      typeof chunk.text === "string"
        ? chunk.text
        : typeof chunk.delta === "string"
          ? chunk.delta
          : "";
    if (text.length === 0) return;

    if (chunk.type === "reasoning-delta") {
      this.#thinkingDelta += text;
      await this.#flushThinkingDeltaIfReady(false);
      return;
    }

    if (chunk.type === "text-delta") {
      this.#messageDelta += text;
      await this.#flushMessageDeltaIfReady(false);
    }
  }

  override async onStepFinish(ctx: StepContext): Promise<void> {
    await this.#flushStreamingDeltas();
    const finishReason = (ctx as { finishReason?: unknown }).finishReason;
    await this.#recordStreamEvent({
      kind: "agent_step",
      title: "Think step finished",
      detail: `finishReason: ${typeof finishReason === "string" ? finishReason : "unknown"}`,
    });
  }

  async awaitAssistantText(submissionId: string): Promise<string> {
    for (;;) {
      const inspection = await this.inspectSubmission(submissionId);
      if (!inspection) throw new Error(`Submission ${submissionId} vanished`);
      if (inspection.status === "completed") {
        const text = collectAssistantText(this.messages);
        if (text.length === 0) {
          throw new Error("Think turn completed without assistant text.");
        }
        return text;
      }
      if (
        inspection.status === "error" ||
        inspection.status === "aborted" ||
        inspection.status === "skipped"
      ) {
        throw new Error(
          `Think turn ended in status=${inspection.status}${inspection.error ? `: ${inspection.error}` : ""}`,
        );
      }
      await scheduler.wait(500);
    }
  }

  async #flushStreamingDeltas(): Promise<void> {
    await this.#flushThinkingDeltaIfReady(true);
    await this.#flushMessageDeltaIfReady(true);
  }

  async #flushThinkingDeltaIfReady(force: boolean): Promise<void> {
    if (this.#thinkingDelta.length === 0) return;
    if (!force && this.#thinkingDelta.length < 80) return;
    const detail = this.#thinkingDelta;
    this.#thinkingDelta = "";
    await this.#recordStreamEvent({
      kind: "agent_thinking_delta",
      title: "Think reasoning stream",
      detail,
    });
  }

  async #flushMessageDeltaIfReady(force: boolean): Promise<void> {
    if (this.#messageDelta.length === 0) return;
    if (!force && this.#messageDelta.length < 80) return;
    const detail = this.#messageDelta;
    this.#messageDelta = "";
    await this.#recordStreamEvent({
      kind: "agent_message_delta",
      title: "Think response stream",
      detail,
    });
  }

  async #recordStreamEvent(input: {
    kind: "agent_message_delta" | "agent_thinking_delta" | "agent_step";
    title: string;
    detail: string;
  }): Promise<void> {
    await this.#activeRecorder?.record({
      runtime: this.runtime,
      ...input,
    });
  }
}

export class WorkspaceThinkAgent extends RuntimeThinkAgent {
  readonly runtime = "workspace";
  readonly runtimeLabel = "Workspace";
  readonly #ctx: DurableObjectState;
  #activeBackend: CloudflareContainerBackend | null = null;
  #activeWorkspace: Workspace | null = null;

  constructor(ctx: DurableObjectState, env: RuntimeThinkAgentEnv) {
    super(ctx, env);
    this.#ctx = ctx;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws" && this.#activeBackend) {
      return this.#activeBackend.handleFetch(request);
    }
    return super.fetch(request);
  }

  async getWorkspace(): Promise<WorkspaceStub> {
    return this.__getWorkspaceStub();
  }

  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    if (!this.#activeWorkspace) {
      throw new Error("WorkspaceThinkAgent has no active Workspace session.");
    }
    await this.#activeWorkspace.ready();
    return this.#activeWorkspace.stub();
  }

  protected async runWithRuntime(
    config: RunConfig,
    recorder: RuntimeThinkToolRecorder,
  ): Promise<void> {
    const session = this.createWorkspaceSession(config, recorder);
    this.#activeBackend = session.backend;
    this.#activeWorkspace = session.workspace;
    try {
      await seedFixture(createWorkspaceFixtureRuntime(session.workspace), config.fixture);
      const adapter = createWorkspaceRuntimeAdapter({
        recorder,
        store: createWorkspaceFileStore(session.workspace),
        runner: createWorkspaceCommandRunner(session.workspace),
      });
      await this.runThinkTurn(adapter, recorder, config.fixture);
    } finally {
      if (this.#activeBackend === session.backend) {
        this.#activeBackend = null;
      }
      if (this.#activeWorkspace === session.workspace) {
        this.#activeWorkspace = null;
      }
      await session.close();
    }
  }

  private createWorkspaceSession(
    config: RunConfig,
    recorder: RuntimeThinkToolRecorder,
  ): WorkspaceRunSession {
    const workspaceRef = { binding: "WorkspaceThinkAgent", id: this.#ctx.id.toString() };
    let assignedContainerId: string | null = null;
    const backend = new CloudflareContainerBackend({
      id: "container",
      container: async () => {
        const containerId = await getWarmPoolHandle(this.env.WorkspaceWarmPool).getContainer(
          config.runId,
        );
        if (assignedContainerId !== containerId) {
          assignedContainerId = containerId;
          await recordContainerLifecycle(recorder, {
            runtime: this.runtime,
            kind: "container_acquired",
            executionTarget: "computer-container",
            containerId,
          });
        }
        return this.env.WorkspaceContainerHost.get(
          this.env.WorkspaceContainerHost.idFromName(containerId),
        );
      },
      workspace: workspaceRef,
      egress: { mode: "direct" },
      containerEnv: this.env.FUSE_MOUNT ? { FUSE_MOUNT: this.env.FUSE_MOUNT } : undefined,
    });
    const workspace = new Workspace({
      storage: this.#ctx.storage as unknown as DurableObjectStorageLike,
      backends: [
        new WorkerShellBackend({
          id: "shell",
          loader: this.env.LOADER,
          workspace: workspaceRef,
          ctx: this.#ctx,
        }),
        backend,
      ],
    });
    return {
      backend,
      workspace,
      close: () =>
        this.closeWorkspaceSession(config.runId, workspace, recorder, () => assignedContainerId),
    };
  }

  private async closeWorkspaceSession(
    runId: string,
    workspace: Workspace,
    recorder: RuntimeThinkToolRecorder,
    assignedContainerId: () => string | null,
  ): Promise<void> {
    await bestEffortCleanup("Workspace session close", () => workspace.close());
    await bestEffortCleanup("Workspace warm-pool release", async () => {
      await getWarmPoolHandle(this.env.WorkspaceWarmPool).releaseContainer(runId);
      const containerId = assignedContainerId();
      if (containerId) {
        await recordContainerLifecycle(recorder, {
          runtime: this.runtime,
          kind: "container_released",
          executionTarget: "computer-container",
          containerId,
        });
      }
    });
  }
}

export class SandboxThinkAgent extends RuntimeThinkAgent {
  readonly runtime = "sandbox";
  readonly runtimeLabel = "Sandbox";

  protected async runWithRuntime(
    config: RunConfig,
    recorder: RuntimeThinkToolRecorder,
  ): Promise<void> {
    const { containerId, sandbox, session } = await this.createSandboxSession(config.runId);
    await recordContainerLifecycle(recorder, {
      runtime: this.runtime,
      kind: "container_acquired",
      executionTarget: "sandbox-container",
      containerId,
    });
    try {
      await seedFixture(createSandboxFixtureRuntime(session), config.fixture);
      await assertSandboxFixtureVisible(session, config.fixture);
      const adapter = createSandboxRuntimeAdapter({
        recorder,
        store: createSandboxFileStore(session),
        runner: createSandboxCommandRunner(session),
      });
      await this.runThinkTurn(adapter, recorder, config.fixture);
    } finally {
      await bestEffortCleanup("Sandbox session delete", async () => {
        await sandbox.deleteSession(session.id);
      });
      await bestEffortCleanup("Sandbox warm-pool release", async () => {
        await this.getWarmPool().releaseContainer(config.runId);
        await recordContainerLifecycle(recorder, {
          runtime: this.runtime,
          kind: "container_released",
          executionTarget: "sandbox-container",
          containerId,
        });
      });
    }
  }

  private async createSandboxSession(runId: string): Promise<SandboxRunSession> {
    const containerId = await this.getWarmPool().getContainer(runId);
    const sandbox = getSandbox(this.env.Sandbox, containerId, {
      sleepAfter: containerSleepAfter(this.env),
    }) as unknown as SandboxSessionOwner;
    const session = await sandbox.createSession({ id: sandboxSessionId(runId), cwd: "/" });
    return { containerId, sandbox, session };
  }

  private getWarmPool(): ContainerWarmPoolHandle {
    return getWarmPoolHandle(this.env.SandboxWarmPool);
  }
}

interface WorkspaceRunSession {
  backend: CloudflareContainerBackend;
  workspace: Workspace;
  close(): Promise<void>;
}

interface SandboxRunSession {
  containerId: string;
  sandbox: SandboxSessionOwner;
  session: SandboxRuntimeSession;
}

interface SandboxSessionOwner {
  createSession(options: { id: string; cwd: string }): Promise<SandboxRuntimeSession>;
  deleteSession(sessionId: string): Promise<unknown>;
}

interface SandboxRuntimeSession {
  id: string;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, contents: string): Promise<unknown>;
  readFile(path: string): Promise<{ content: string | Uint8Array }>;
  exec(
    command: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

async function assertSandboxFixtureVisible(
  session: SandboxRuntimeSession,
  fixture: ComparisonFixture,
): Promise<void> {
  const command = [
    `test -d ${shellQuote(fixture.root)}`,
    ...fixture.files.map((file) => `test -f ${shellQuote(fixturePath(fixture.root, file))}`),
  ].join(" && ");
  const result = await session.exec(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `Sandbox fixture seed is not visible to exec: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    );
  }
}

function fixturePath(root: string, file: FixtureFile): string {
  return `${root.replace(/\/+$/, "")}/${file.path.replace(/^\/+/, "")}`;
}

function sandboxSessionId(runId: string): string {
  return `${runId.replace(/[^a-zA-Z0-9_-]/g, "-")}-sandbox-agent`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function recordContainerLifecycle(
  recorder: RuntimeThinkToolRecorder,
  input: {
    runtime: RuntimeId;
    kind: Extract<RunEventKind, "container_acquired" | "container_released">;
    executionTarget: ExecutionTarget;
    containerId: string;
  },
): Promise<void> {
  await recorder.record({
    runtime: input.runtime,
    kind: input.kind,
    title: input.kind === "container_acquired" ? "Container assigned" : "Container released",
    detail: JSON.stringify({
      executionTarget: input.executionTarget,
      containerId: input.containerId,
    }),
  });
}

async function bestEffortCleanup(label: string, cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    console.warn(`${label} failed`, { error });
  }
}

function collectAssistantText(messages: Array<{ role?: string; parts?: Array<unknown> }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const parts = message.parts ?? [];
    const text = parts
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const candidate = part as { type?: string; text?: unknown };
        return candidate.type === "text" && typeof candidate.text === "string"
          ? candidate.text
          : "";
      })
      .join("")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
}
