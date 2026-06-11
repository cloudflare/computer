import type { RuntimeId } from "../../shared/events";
import type { ComparisonFixture } from "../../shared/fixture";

export interface RuntimeThinkAgentRunInput {
  runId: string;
  fixture: ComparisonFixture;
}

export interface RuntimeThinkAgentHandle {
  runComparison(input: RuntimeThinkAgentRunInput): Promise<void>;
}

export type RuntimeThinkAgentHandleInput =
  | RuntimeThinkAgentHandle
  | Promise<RuntimeThinkAgentHandle>;

export interface StartRuntimeThinkAgentsOptions {
  runId: string;
  fixture: ComparisonFixture;
  workspaceAgent: RuntimeThinkAgentHandleInput;
  sandboxAgent: RuntimeThinkAgentHandleInput;
  onAgentStart?: (runtime: RuntimeId) => void | Promise<void>;
  onAgentComplete?: (runtime: RuntimeId) => void | Promise<void>;
  onAgentError?: (runtime: RuntimeId, error: unknown) => void | Promise<void>;
}

export async function startRuntimeThinkAgents({
  runId,
  fixture,
  workspaceAgent,
  sandboxAgent,
  onAgentStart,
  onAgentComplete,
  onAgentError,
}: StartRuntimeThinkAgentsOptions): Promise<void> {
  const agents: Array<{ runtime: RuntimeId; agent: RuntimeThinkAgentHandleInput }> = [
    { runtime: "workspace", agent: workspaceAgent },
    { runtime: "sandbox", agent: sandboxAgent },
  ];

  const runs = agents.map(async ({ runtime, agent }) => {
    try {
      const resolvedAgent = await agent;
      await onAgentStart?.(runtime);
      await resolvedAgent.runComparison({ runId, fixture });
      await onAgentComplete?.(runtime);
    } catch (error) {
      await onAgentError?.(runtime, error);
    }
  });

  await Promise.all(runs);
}
