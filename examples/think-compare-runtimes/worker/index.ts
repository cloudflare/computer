import type { Sandbox as SandboxDO } from "@cloudflare/sandbox";
import type { WorkerBackendOptions } from "@cloudflare/workspace/backends/worker";
import { getServerByName, routePartykitRequest, Server } from "partyserver";
import type { RunEvent } from "../shared/events";
import { comparisonFixture } from "../shared/fixture";
import { runComparisonAgents } from "./comparison-agents";
import {
  type ContainerWarmPoolNamespace,
  getWarmPoolHandle,
  SandboxWarmPool,
  WorkspaceContainerHost,
  WorkspaceWarmPool,
} from "./container-pools";
import { handleApiRequest } from "./http";
import type { RunEventInput } from "./run-events";
import { getRuntimeAgentHandles } from "./runtime-agent-handles";
import { startComparisonRun } from "./start-run";
import { SandboxThinkAgent, WorkspaceProxy, WorkspaceThinkAgent } from "./think/agents";

export { Sandbox } from "@cloudflare/sandbox";
export {
  SandboxThinkAgent,
  SandboxWarmPool,
  WorkspaceContainerHost,
  WorkspaceProxy,
  WorkspaceThinkAgent,
  WorkspaceWarmPool,
};

export interface Env {
  AI: Ai;
  CompareRun: DurableObjectNamespace<CompareRun>;
  LOADER: WorkerBackendOptions["loader"];
  SANDBOX_TRANSPORT: "rpc";
  CONTAINER_SLEEP_AFTER?: string;
  WARM_POOL_REFRESH_INTERVAL?: string;
  WARM_POOL_RESET_KEY?: string;
  WARM_POOL_TARGET?: string;
  FUSE_SHIM?: string;
  Sandbox: DurableObjectNamespace<SandboxDO>;
  SandboxWarmPool: ContainerWarmPoolNamespace;
  WorkspaceContainerHost: DurableObjectNamespace<WorkspaceContainerHost>;
  WorkspaceWarmPool: ContainerWarmPoolNamespace;
  WorkspaceThinkAgent: DurableObjectNamespace<WorkspaceThinkAgent>;
  SandboxThinkAgent: DurableObjectNamespace<SandboxThinkAgent>;
}

const EVENTS_KEY = "events";

export class CompareRun extends Server<Env> {
  static override options = { hibernate: true };

  #events: RunEvent[] = [];
  #appendQueue: Promise<unknown> = Promise.resolve();
  readonly #started: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#started = this.#loadEvents();
    ctx.blockConcurrencyWhile(() => this.#started);
  }

  override async onStart(): Promise<void> {
    await this.#started;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return super.fetch(request);
  }

  override onConnect(connection: WebSocket): void {
    connection.send(JSON.stringify({ type: "history", events: this.#events }));
  }

  async appendEvent(input: RunEventInput): Promise<RunEvent> {
    await this.#started;
    const appended = this.#appendQueue.then(() => this.#appendEventNow(input));
    this.#appendQueue = appended.catch(() => {});
    return appended;
  }

  async startComparison(): Promise<RunEvent[]> {
    await this.#started;
    const runId = this.name;
    this.#events = [];
    await this.ctx.storage.put(EVENTS_KEY, this.#events);
    await this.appendEvent({
      runtime: "both",
      kind: "run_started",
      title: "Comparison run started",
      detail: "Workspace and Sandbox Think agents are running from the same fixture.",
    });

    this.ctx.waitUntil(this.#startAgents(runId));
    return this.#events;
  }

  async #startAgents(runId: string): Promise<void> {
    try {
      const { workspaceAgent, sandboxAgent } = await getRuntimeAgentHandles({
        runId,
        workspaceNamespace: this.env.WorkspaceThinkAgent,
        sandboxNamespace: this.env.SandboxThinkAgent,
      });
      await runComparisonAgents({
        runId,
        fixture: comparisonFixture,
        workspaceAgent,
        sandboxAgent,
        appendEvent: async (input) => {
          await this.appendEvent(input);
        },
      });
    } catch (error) {
      await this.appendEvent({
        runtime: "both",
        kind: "agent_tool_error",
        title: "Comparison run failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #loadEvents(): Promise<void> {
    this.#events = (await this.ctx.storage.get<RunEvent[]>(EVENTS_KEY)) ?? [];
  }

  async #appendEventNow(input: RunEventInput): Promise<RunEvent> {
    const sequence = this.#events.length;
    const event: RunEvent = {
      ...input,
      id: `${this.name}:${sequence}`,
      runId: this.name,
      sequence,
      timestamp: new Date().toISOString(),
    };
    this.#events = [...this.#events, event];
    await this.ctx.storage.put(EVENTS_KEY, this.#events);
    this.broadcast(JSON.stringify({ type: "event", event }));
    return event;
  }
}

export default {
  async fetch(request, env) {
    const apiResponse = await handleApiRequest(request, () =>
      startComparisonRun({
        getRun: (runId) => getServerByName(env.CompareRun, runId),
      }),
    );

    if (apiResponse) {
      return apiResponse;
    }

    return (await routePartykitRequest(request, env)) ?? new Response(null, { status: 404 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(getWarmPoolHandle(env.WorkspaceWarmPool).refresh());
    ctx.waitUntil(getWarmPoolHandle(env.SandboxWarmPool).refresh());
  },
} satisfies ExportedHandler<Env>;
