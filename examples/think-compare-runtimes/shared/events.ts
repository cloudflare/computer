export type RuntimeId = "workspace" | "sandbox";
export type EventRuntime = RuntimeId | "both";
export type ExecutionTarget = "worker-shell" | "workspace-container" | "sandbox-container";

export type RunEventKind =
  | "run_started"
  | "run_completed"
  | "runtime_started"
  | "runtime_completed"
  | "runtime_failed"
  | "runtime_note"
  | "agent_message"
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
