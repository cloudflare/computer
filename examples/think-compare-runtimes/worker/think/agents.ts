import { getSandbox, type Sandbox as SandboxDO } from "@cloudflare/sandbox";
import { Think } from "@cloudflare/think";
import { type DurableObjectStorageLike, Workspace, WorkspaceProxy } from "@cloudflare/workspace";
import { CloudflareContainerBackend } from "@cloudflare/workspace/backends/container";
import { WorkerBackend, type WorkerBackendOptions } from "@cloudflare/workspace/backends/worker";
import type { ToolSet } from "ai";
import { getServerByName } from "partyserver";
import type { RuntimeId } from "../../shared/events";
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

export { WorkspaceProxy };

export interface RuntimeThinkAgentEnv {
  AI: Ai;
  CompareRun: DurableObjectNamespace<CompareRun>;
  Sandbox: DurableObjectNamespace<SandboxDO>;
  SandboxWarmPool: ContainerWarmPoolNamespace;
  WorkspaceContainerHost: DurableObjectNamespace<WorkspaceContainerHost>;
  WorkspaceWarmPool: ContainerWarmPoolNamespace;
  CONTAINER_SLEEP_AFTER?: string;
  FUSE_SHIM?: string;
  LOADER: WorkerBackendOptions["loader"];
  WARM_POOL_RESET_KEY?: string;
}

interface RunConfig {
  runId: string;
  fixture: ComparisonFixture;
}

abstract class RuntimeThinkAgent extends Think<RuntimeThinkAgentEnv> {
  #preparedTools: ToolSet | null = null;

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

  protected async runThinkTurn(
    adapter: RuntimeAdapter,
    recorder: RuntimeThinkToolRecorder,
    fixture: ComparisonFixture,
  ): Promise<void> {
    this.#preparedTools = createRuntimeThinkTools({ adapter, recorder }) as unknown as ToolSet;

    await runRealThinkTurn({
      adapter,
      recorder,
      fixture,
      invoke: ({ prompt }) => this.invokeThink(prompt),
    });
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
}

export class WorkspaceThinkAgent extends RuntimeThinkAgent {
  readonly runtime = "workspace";
  readonly runtimeLabel = "Workspace";
  readonly #ctx: DurableObjectState;
  #activeBackend: CloudflareContainerBackend | null = null;

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

  protected async runWithRuntime(
    config: RunConfig,
    recorder: RuntimeThinkToolRecorder,
  ): Promise<void> {
    const session = this.createWorkspaceSession(config);
    this.#activeBackend = session.backend;
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
      await session.close();
    }
  }

  private createWorkspaceSession(config: RunConfig): WorkspaceRunSession {
    const workspaceRef = { binding: "WorkspaceThinkAgent", id: this.#ctx.id.toString() };
    const backend = new CloudflareContainerBackend({
      id: "container",
      container: () => this.getWorkspaceContainerHost(config.runId),
      workspace: workspaceRef,
      containerEnv: this.env.FUSE_SHIM ? { FUSE_SHIM: this.env.FUSE_SHIM } : undefined,
    });
    const workspace = new Workspace({
      storage: this.#ctx.storage as unknown as DurableObjectStorageLike,
      backends: [
        new WorkerBackend({
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
      close: () => this.closeWorkspaceSession(config.runId, workspace),
    };
  }

  private async closeWorkspaceSession(runId: string, workspace: Workspace): Promise<void> {
    await bestEffortCleanup("Workspace session close", () => workspace.close());
    await bestEffortCleanup("Workspace warm-pool release", () =>
      getWarmPoolHandle(this.env.WorkspaceWarmPool).releaseContainer(runId),
    );
  }

  private async getWorkspaceContainerHost(runId: string) {
    const containerId = await getWarmPoolHandle(this.env.WorkspaceWarmPool).getContainer(runId);
    return this.env.WorkspaceContainerHost.get(
      this.env.WorkspaceContainerHost.idFromName(containerId),
    );
  }
}

export class SandboxThinkAgent extends RuntimeThinkAgent {
  readonly runtime = "sandbox";
  readonly runtimeLabel = "Sandbox";

  protected async runWithRuntime(
    config: RunConfig,
    recorder: RuntimeThinkToolRecorder,
  ): Promise<void> {
    const { sandbox, session } = await this.createSandboxSession(config.runId);
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
      await bestEffortCleanup("Sandbox warm-pool release", () =>
        this.getWarmPool().releaseContainer(config.runId),
      );
    }
  }

  private async createSandboxSession(runId: string): Promise<SandboxRunSession> {
    const containerId = await this.getWarmPool().getContainer(runId);
    const sandbox = getSandbox(this.env.Sandbox, containerId, {
      sleepAfter: containerSleepAfter(this.env),
    }) as unknown as SandboxSessionOwner;
    const session = await sandbox.createSession({ id: sandboxSessionId(runId), cwd: "/" });
    return { sandbox, session };
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
  for (const file of fixture.files) {
    await session.readFile(fixturePath(fixture.root, file));
  }

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
