import { getAgentByName } from "agents";
import type { RuntimeThinkAgentHandle, RuntimeThinkAgentHandleInput } from "./think/agent-starter";

export interface RuntimeAgentHandles {
  workspaceAgent: RuntimeThinkAgentHandleInput;
  sandboxAgent: RuntimeThinkAgentHandleInput;
}

export interface GetRuntimeAgentHandlesOptions {
  runId: string;
  workspaceNamespace: DurableObjectNamespace;
  sandboxNamespace: DurableObjectNamespace;
  getAgent?: (namespace: DurableObjectNamespace, name: string) => Promise<unknown>;
}

export function getRuntimeAgentHandles({
  runId,
  workspaceNamespace,
  sandboxNamespace,
  getAgent = getRuntimeAgentByName,
}: GetRuntimeAgentHandlesOptions): RuntimeAgentHandles {
  return {
    workspaceAgent: getAgent(
      workspaceNamespace,
      `${runId}-workspace`,
    ) as Promise<RuntimeThinkAgentHandle>,
    sandboxAgent: getAgent(
      sandboxNamespace,
      `${runId}-sandbox`,
    ) as Promise<RuntimeThinkAgentHandle>,
  };
}

async function getRuntimeAgentByName(
  namespace: DurableObjectNamespace,
  name: string,
): Promise<unknown> {
  const getAgent = getAgentByName as unknown as (
    namespace: DurableObjectNamespace,
    name: string,
  ) => Promise<unknown>;
  return getAgent(namespace, name);
}
