import type { RuntimeId } from "../shared/events";
import type { ComparisonFixture } from "../shared/fixture";
import type { RunEventInput } from "./run-events";
import { type RuntimeThinkAgentHandleInput, startRuntimeThinkAgents } from "./think/agent-starter";

export interface RunComparisonAgentsOptions {
  runId: string;
  fixture: ComparisonFixture;
  workspaceAgent: RuntimeThinkAgentHandleInput;
  sandboxAgent: RuntimeThinkAgentHandleInput;
  appendEvent(input: RunEventInput): void | Promise<void>;
}

type RuntimeTerminalStatus = "completed" | "failed";

export async function runComparisonAgents({
  runId,
  fixture,
  workspaceAgent,
  sandboxAgent,
  appendEvent,
}: RunComparisonAgentsOptions): Promise<void> {
  const terminalStatuses = new Map<RuntimeId, RuntimeTerminalStatus>();

  await startRuntimeThinkAgents({
    runId,
    fixture,
    workspaceAgent,
    sandboxAgent,
    onAgentStart(runtime) {
      return appendEvent({
        runtime,
        kind: "runtime_started",
        title: `${runtimeLabel(runtime)} runtime started`,
        detail: `${runtimeLabel(runtime)} Think agent is running.`,
      });
    },
    async onAgentComplete(runtime) {
      terminalStatuses.set(runtime, "completed");
      await appendEvent({
        runtime,
        kind: "runtime_completed",
        title: `${runtimeLabel(runtime)} runtime completed`,
        detail: `${runtimeLabel(runtime)} Think agent completed.`,
      });
    },
    async onAgentError(runtime, error) {
      terminalStatuses.set(runtime, "failed");
      await appendEvent({
        runtime,
        kind: "runtime_failed",
        title: `${runtimeLabel(runtime)} runtime failed`,
        detail: error instanceof Error ? error.message : String(error),
      });
    },
  });

  await appendEvent({
    runtime: "both",
    kind: "run_completed",
    title: "Comparison run complete",
    detail: runCompletionDetail(terminalStatuses),
  });
}

function runCompletionDetail(statuses: Map<RuntimeId, RuntimeTerminalStatus>): string {
  const runtimes: RuntimeId[] = ["workspace", "sandbox"];
  return runtimes
    .map((runtime) => `${runtimeLabel(runtime)} ${statuses.get(runtime) ?? "unknown"}`)
    .join("; ")
    .concat(".");
}

function runtimeLabel(runtime: RuntimeId): "Workspace" | "Sandbox" {
  return runtime === "workspace" ? "Workspace" : "Sandbox";
}
