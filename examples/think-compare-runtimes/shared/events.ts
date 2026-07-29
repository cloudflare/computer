export type RuntimeId = "workspace" | "sandbox";
export type EventRuntime = RuntimeId | "both";
export type ExecutionTarget = "worker-shell" | "computer-container" | "sandbox-container";

export type RunEventKind =
  | "run_started"
  | "run_completed"
  | "runtime_started"
  | "runtime_completed"
  | "runtime_failed"
  | "runtime_note"
  | "container_acquired"
  | "container_released"
  | "container_release_scheduled"
  | "agent_message"
  | "agent_message_delta"
  | "agent_thinking_delta"
  | "agent_step"
  | "agent_tool_call"
  | "agent_tool_result"
  | "agent_tool_error"
  | "tool_call"
  | "tool_result"
  | "tool_error";

export interface RunEvent {
  id: string;
  runId: string;
  sequence: number;
  runtime: EventRuntime;
  kind: RunEventKind;
  title: string;
  detail: string;
  timestamp: string;
}
