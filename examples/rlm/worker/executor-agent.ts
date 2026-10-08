import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { Workspace, type WorkspaceRuntimeLoader } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import type { Connection } from "agents";
import { isStepCount, streamText, type ToolSet } from "ai";

import type { BenchmarkAgentState } from "../shared/types";
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
import { userFacingError } from "./errors";
import {
  createExecutorTool,
  EXECUTOR_BACKEND,
  extractExecutionResult,
  extractGeneratedSourceBytes,
} from "./executor-tool";
import { scoreFixtureExecution } from "./fixture-types";
import { completeInference, startInference, withCombinedMetrics } from "./metrics";
import { createModel, type ModelEnv } from "./model";
import { computerPrompt, EXECUTOR_SYSTEM_PROMPT, PARENT_GENERATION_SETTINGS } from "./prompts";
import { requiredComputerStep } from "./step-settings";

export class ExecutorAgent extends AIChatAgent<ModelEnv, BenchmarkAgentState> {
  initialState = initialAgentState("executor");
  readonly #workspace: Workspace;
  readonly #tools: ToolSet;
  #active = false;

  constructor(ctx: DurableObjectState, env: ModelEnv) {
    super(ctx, env);
    const backend = new WorkerJavaScriptBackend({
      id: EXECUTOR_BACKEND,
      loader: env.LOADER as unknown as WorkspaceRuntimeLoader,
      root: WORKSPACE_ROOT,
      access: "read",
      egress: { mode: "none" },
      maxConcurrentCapabilityCalls: 4,
      maxCapabilityCalls: 24,
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
      storage: ctx.storage,
      backends: [backend],
    });
    this.#tools = createExecutorTool(this.#workspace, EXECUTOR_BACKEND);
  }

  override validateStateChange(_next: BenchmarkAgentState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("Benchmark state is server-owned.");
  }

  override async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions,
  ): Promise<Response> {
    const request = parseBenchmarkRequest(options?.body);
    if (this.#active) throw new Error("A JavaScript Only run is already active.");
    this.#active = true;
    const signal = boundedSignal(options?.abortSignal);
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
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
    const prompt = computerPrompt(fixture, "executor");
    let run = createRun("executor", request, fixture);
    let metrics = run.metrics;
    let executionValue: unknown;
    let hasExecutionResult = false;
    this.setState({ ...this.state, status: "running", prompt, run });

    const publish = () => {
      run = updateMetrics(run, metrics);
      this.setState({ ...this.state, run });
    };
    const result = streamText({
      abortSignal: signal,
      model: createModel(this.env),
      ...PARENT_GENERATION_SETTINGS,
      system: EXECUTOR_SYSTEM_PROMPT,
      prompt,
      tools: this.#tools,
      stopWhen: isStepCount(3),
      prepareStep: ({ stepNumber, messages }) =>
        requiredComputerStep(stepNumber, EXECUTOR_SYSTEM_PROMPT, messages),
      onStepStart: () => {
        metrics = { ...metrics, parent: startInference(metrics.parent) };
        publish();
      },
      onStepEnd: ({ usage, toolCalls, toolResults }) => {
        const execution = extractExecutionResult(toolResults);
        metrics = {
          ...metrics,
          parent: completeInference(metrics.parent, usage),
          executionAttempts:
            metrics.executionAttempts +
            toolCalls.filter((call) => call.toolName === "executor").length,
          generatedSourceBytes:
            metrics.generatedSourceBytes + extractGeneratedSourceBytes(toolCalls),
          executionResultBytes: metrics.executionResultBytes + execution.bytes,
        };
        if (execution.found) {
          executionValue = execution.value;
          hasExecutionResult = true;
        }
        publish();
      },
      onFinish: ({ text }) => {
        this.#active = false;
        metrics = withCombinedMetrics({ ...metrics, durationMs: Date.now() - startedAtMs });
        run = {
          ...run,
          metrics,
          score: hasExecutionResult ? scoreFixtureExecution(fixture, executionValue) : null,
        };
        this.setState({
          ...this.state,
          status: hasExecutionResult ? "completed" : "failed",
          finalAnswer: text,
          error: hasExecutionResult
            ? null
            : metrics.executionAttempts > 0
              ? "Generated JavaScript execution failed."
              : "The model did not call the JavaScript executor.",
          finishedAt: new Date().toISOString(),
          run,
        });
      },
      onError: ({ error }) =>
        this.#finishWithoutScore("failed", userFacingError(error), run, metrics, startedAtMs),
      onAbort: () => this.#finishWithoutScore("cancelled", null, run, metrics, startedAtMs),
    });
    return result.toUIMessageStreamResponse();
  }

  #finishWithoutScore(
    status: "failed" | "cancelled",
    error: string | null,
    run: NonNullable<BenchmarkAgentState["run"]>,
    metrics: NonNullable<BenchmarkAgentState["run"]>["metrics"],
    startedAtMs: number,
  ): void {
    this.#active = false;
    const finishedRun = {
      ...run,
      metrics: withCombinedMetrics({ ...metrics, durationMs: Date.now() - startedAtMs }),
    };
    this.setState({
      ...this.state,
      status,
      error,
      finishedAt: new Date().toISOString(),
      run: finishedRun,
    });
  }
}
