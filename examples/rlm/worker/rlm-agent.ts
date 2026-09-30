import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  type DurableObjectStorageLike,
  defineModule,
  Workspace,
  type WorkspaceRuntimeLoader,
} from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import type { Connection } from "agents";
import { isStepCount, streamText, type ToolSet } from "ai";

import type {
  BenchmarkAgentState,
  BenchmarkRun,
  ChildCallTrace,
  RunMetrics,
} from "../shared/types";
import {
  boundedSignal,
  createRun,
  initialAgentState,
  loadFixture,
  seedWorkspace,
  updateMetrics,
  WORKSPACE_ROOT,
} from "./agent-common";
import { parseBenchmarkRequest } from "./benchmark";
import { createModelCapability } from "./capability";
import { userFacingError } from "./errors";
import {
  createExecutorTool,
  extractExecutionResult,
  extractGeneratedSourceBytes,
  RLM_BACKEND,
} from "./executor-tool";
import { scoreFixtureExecution } from "./fixture-types";
import {
  addInferenceUsage,
  completeInference,
  emptyRunMetrics,
  startInference,
  withCombinedMetrics,
} from "./metrics";
import { createModel, type ModelEnv } from "./model";
import { computerPrompt, RLM_PARENT_GENERATION_SETTINGS } from "./prompts";
import { requiredRlmStep } from "./step-settings";
import { structuredRlmSystemPrompt } from "./structured-rlm";

export class RlmAgent extends AIChatAgent<ModelEnv, BenchmarkAgentState> {
  initialState = initialAgentState("rlm");
  readonly #workspace: Workspace;
  readonly #tools: ToolSet;
  #activeRun: BenchmarkRun | null = null;
  #metrics: RunMetrics = emptyRunMetrics();
  #children: ChildCallTrace[] = [];
  #remainingChildCalls = 24;
  #active = false;

  constructor(ctx: DurableObjectState, env: ModelEnv) {
    super(ctx, env);
    const modelCapability = createModelCapability(createModel(env), {
      admit: (requests) => {
        if (requests > this.#remainingChildCalls) return false;
        this.#remainingChildCalls -= requests;
        return true;
      },
      started: ({ id, index }) => {
        this.#metrics = {
          ...this.#metrics,
          children: startInference(this.#metrics.children),
        };
        this.#children = [
          ...this.#children,
          {
            id,
            index,
            status: "running",
            durationMs: null,
            usage: { inputTokens: null, outputTokens: null, totalTokens: null },
            error: null,
          },
        ];
        this.#publishCapabilityState();
      },
      completed: ({ id, durationMs, usage }) => {
        this.#metrics = {
          ...this.#metrics,
          children: addInferenceUsage(this.#metrics.children, usage, true),
        };
        this.#updateChild(id, { status: "completed", durationMs, usage, error: null });
      },
      failed: ({ id, durationMs, usage, error }) => {
        this.#metrics = {
          ...this.#metrics,
          children: addInferenceUsage(this.#metrics.children, usage, false),
        };
        this.#updateChild(id, {
          status: "failed",
          durationMs,
          usage,
          error: userFacingError(new Error(error)),
        });
      },
    });
    const backend = new WorkerJavaScriptBackend({
      id: RLM_BACKEND,
      loader: env.LOADER as unknown as WorkspaceRuntimeLoader,
      root: WORKSPACE_ROOT,
      access: "read",
      egress: { mode: "none" },
      modules: { "ws:model": defineModule(modelCapability) },
      maxConcurrentExecutions: 1,
      maxConcurrentCapabilityCalls: 4,
      // One manifest read + 24 chunk reads + one bounded ws:model batch.
      maxCapabilityCalls: 26,
      maxCapabilityBytes: 4 * 1024 * 1024,
      maxHostCallMs: 300_000,
      maxSourceBytes: 128 * 1024,
      maxInputBytes: 64 * 1024,
      maxResultBytes: 128 * 1024,
      maxStdioBytes: 64 * 1024,
      defaultTimeoutMs: 300_000,
      maxTimeoutMs: 360_000,
    });
    this.#workspace = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends: [backend],
    });
    this.#tools = createExecutorTool(this.#workspace, RLM_BACKEND);
  }

  override validateStateChange(_next: BenchmarkAgentState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("Benchmark state is server-owned.");
  }

  override async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions,
  ): Promise<Response> {
    const request = parseBenchmarkRequest(options?.body);
    if (this.#active) throw new Error("A Structured RLM run is already active.");
    this.#active = true;
    const signal = boundedSignal(options?.abortSignal);
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    this.#metrics = emptyRunMetrics();
    this.#children = [];
    this.#remainingChildCalls = 24;
    this.#activeRun = null;
    this.setState({
      ...this.state,
      status: "loading",
      prompt: "",
      finalAnswer: "",
      error: null,
      startedAt,
      finishedAt: null,
      run: null,
      children: [],
    });
    const fixture = await loadFixture(request.sample, signal).catch((error) => {
      this.#active = false;
      this.setState({
        ...this.state,
        status: signal.aborted ? "cancelled" : "failed",
        error: signal.aborted ? null : userFacingError(error),
        finishedAt: new Date().toISOString(),
      });
      throw error;
    });
    await seedWorkspace(this.#workspace, fixture).catch((error) => {
      this.#active = false;
      this.setState({
        ...this.state,
        status: signal.aborted ? "cancelled" : "failed",
        error: signal.aborted ? null : userFacingError(error),
        finishedAt: new Date().toISOString(),
      });
      throw error;
    });
    const prompt = computerPrompt(fixture, "rlm");
    const systemPrompt = structuredRlmSystemPrompt(fixture);
    this.#activeRun = createRun("rlm", request, fixture);
    this.setState({ ...this.state, status: "running", prompt, run: this.#activeRun });

    let executionValue: unknown;
    let hasExecutionValue = false;
    const result = streamText({
      abortSignal: signal,
      model: createModel(this.env),
      ...RLM_PARENT_GENERATION_SETTINGS,
      system: systemPrompt,
      prompt,
      tools: this.#tools,
      stopWhen: isStepCount(3),
      prepareStep: ({ stepNumber, messages }) =>
        requiredRlmStep(
          stepNumber,
          systemPrompt,
          messages,
          this.#children.some((child) => child.status === "completed"),
        ),
      onStepStart: () => {
        this.#metrics = { ...this.#metrics, parent: startInference(this.#metrics.parent) };
        this.#publishCapabilityState();
      },
      onStepEnd: ({ usage, toolCalls, toolResults }) => {
        const execution = extractExecutionResult(toolResults);
        this.#metrics = {
          ...this.#metrics,
          parent: completeInference(this.#metrics.parent, usage),
          executionAttempts:
            this.#metrics.executionAttempts +
            toolCalls.filter((call) => call.toolName === "executor").length,
          generatedSourceBytes:
            this.#metrics.generatedSourceBytes + extractGeneratedSourceBytes(toolCalls),
          executionResultBytes: this.#metrics.executionResultBytes + execution.bytes,
        };
        if (!hasExecutionValue && execution.found && hasTypedAnswer(execution.value)) {
          executionValue = execution.value;
          hasExecutionValue = true;
        }
        this.#publishCapabilityState();
      },
      onFinish: ({ text }) => {
        this.#active = false;
        this.#metrics = withCombinedMetrics({
          ...this.#metrics,
          durationMs: Date.now() - startedAtMs,
        });
        const current = this.#activeRun;
        if (!current) return;
        const completedMap = this.#children.some((child) => child.status === "completed");
        const successful = hasExecutionValue && completedMap;
        this.#activeRun = {
          ...current,
          metrics: this.#metrics,
          score: successful ? scoreFixtureExecution(fixture, executionValue) : null,
        };
        this.setState({
          ...this.state,
          status: successful ? "completed" : "failed",
          finalAnswer: text,
          error: !hasExecutionValue
            ? "The model did not return a successful execution result."
            : completedMap
              ? null
              : "The generated module did not use its ws:model map capability.",
          finishedAt: new Date().toISOString(),
          run: this.#activeRun,
          children: this.#children,
        });
      },
      onError: ({ error }) => this.#finish("failed", userFacingError(error), startedAtMs),
      onAbort: () => this.#finish("cancelled", null, startedAtMs),
    });
    return result.toUIMessageStreamResponse();
  }

  #updateChild(id: string, update: Partial<ChildCallTrace>): void {
    this.#children = this.#children.map((child) =>
      child.id === id ? { ...child, ...update } : child,
    );
    this.#publishCapabilityState();
  }

  #publishCapabilityState(): void {
    if (!this.#activeRun) return;
    this.#activeRun = updateMetrics(this.#activeRun, this.#metrics);
    this.setState({ ...this.state, run: this.#activeRun, children: this.#children });
  }

  #finish(status: "failed" | "cancelled", error: string | null, startedAtMs: number): void {
    this.#active = false;
    this.#metrics = withCombinedMetrics({
      ...this.#metrics,
      durationMs: Date.now() - startedAtMs,
    });
    if (this.#activeRun) this.#activeRun = { ...this.#activeRun, metrics: this.#metrics };
    this.setState({
      ...this.state,
      status,
      error,
      finishedAt: new Date().toISOString(),
      run: this.#activeRun,
      children: this.#children,
    });
  }
}

function hasTypedAnswer(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "answer" in value;
}
