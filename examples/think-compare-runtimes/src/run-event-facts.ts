import type { EventRuntime, ExecutionTarget, RunEvent, RuntimeId } from "../shared/events";

export type RuntimeMatchPolicy = "runtimeOnly" | "runtimeOrShared";
export type ToolName = "read" | "write" | "edit" | "exec";
export type EventPhase = "call" | "result" | "error" | "message" | "lifecycle" | "note";
export interface EventDetailField {
  label: string;
  value: string;
}

export interface RunEventFact {
  event: RunEvent;
  sequence: number;
  runtime: EventRuntime;
  phase: EventPhase;
  tool: ToolName | null;
  path: string | null;
  command: string | null;
  cwd: string | null;
  executionTarget: ExecutionTarget | null;
  exitCode: number | null;
  validationCommand: boolean;
  failed: boolean;
  text: string | null;
  detail: Record<string, unknown> | null;
}

const toolNames: ToolName[] = ["read", "write", "edit", "exec"];
const preferredDetailFields = [
  "command",
  "path",
  "cwd",
  "executionTarget",
  "exitCode",
  "stdout",
  "stderr",
  "error",
];

export function factForEvent(event: RunEvent): RunEventFact {
  const detail = parseJsonObject(event.detail);
  const command = stringField(detail, "command");
  const path = stringField(detail, "path");
  const exitCode = numberField(detail, "exitCode");
  const phase = phaseForEvent(event);
  const tool = toolForEvent(event, detail);

  return {
    event,
    sequence: event.sequence,
    runtime: event.runtime,
    phase,
    tool,
    path,
    command,
    cwd: stringField(detail, "cwd"),
    executionTarget: executionTargetForEvent(event, detail),
    exitCode,
    validationCommand: typeof command === "string" && /npm\s+run\s+check/.test(command),
    failed: phase === "error" || (typeof exitCode === "number" && exitCode !== 0),
    text: detail ? null : event.detail,
    detail,
  };
}

export function factsForRuntime(
  events: RunEvent[],
  runtime: RuntimeId,
  policy: RuntimeMatchPolicy,
): RunEventFact[] {
  return events
    .filter((event) => eventMatchesRuntime(event, runtime, policy))
    .sort((left, right) => left.sequence - right.sequence)
    .map(factForEvent);
}

export function eventMatchesRuntime(
  event: RunEvent,
  runtime: RuntimeId,
  policy: RuntimeMatchPolicy,
): boolean {
  if (event.runtime === runtime) return true;
  return policy === "runtimeOrShared" && event.runtime === "both";
}

export function detailFieldsForEvent(event: RunEvent): EventDetailField[] {
  const fact = factForEvent(event);
  if (!fact.detail) return [];
  return orderedEntries(fact.detail).map(([label, value]) => ({
    label,
    value: stringifyFieldValue(value),
  }));
}

export function execObservationFacts(facts: RunEventFact[]): RunEventFact[] {
  const callsByCommand = new Map<string, RunEventFact>();
  const results: RunEventFact[] = [];

  for (const fact of facts) {
    if (fact.tool !== "exec" || !fact.command) continue;
    if (fact.phase === "result" || fact.phase === "error") {
      results.push(fact);
    } else if (fact.phase === "call") {
      callsByCommand.set(fact.command, fact);
    }
  }

  const resultCommands = new Set(results.map((fact) => fact.command));
  const unpairedCalls = [...callsByCommand.values()].filter(
    (fact) => !resultCommands.has(fact.command),
  );
  return [...results, ...unpairedCalls].sort((left, right) => left.sequence - right.sequence);
}

export function readableDetail(fact: RunEventFact): string {
  if (!fact.detail) return fact.text ?? "";
  const error = stringField(fact.detail, "error");
  if (error) return error;
  const message = stringField(fact.detail, "message");
  if (message) return message;
  if (fact.command) return fact.command;
  if (fact.path) return trimWorkspaceRoot(fact.path);
  return fact.event.detail;
}

export function trimWorkspaceRoot(path: string): string {
  return path.replace(/^\/workspace\/repo\//, "");
}

function phaseForEvent(event: RunEvent): EventPhase {
  if (event.kind === "agent_message") return "message";
  if (event.kind.endsWith("_call")) return "call";
  if (event.kind.endsWith("_result")) return "result";
  if (event.kind.endsWith("_error") || event.kind === "runtime_failed") return "error";
  if (event.kind.startsWith("run_") || event.kind.startsWith("runtime_")) return "lifecycle";
  return "note";
}

function toolForEvent(event: RunEvent, detail: Record<string, unknown> | null): ToolName | null {
  const fromDetail = stringField(detail, "tool");
  if (isToolName(fromDetail)) return fromDetail;
  if (typeof stringField(detail, "command") === "string") return "exec";
  const title = event.title.toLowerCase();
  return toolNames.find((name) => title.includes(name)) ?? null;
}

function executionTargetForEvent(
  event: RunEvent,
  detail: Record<string, unknown> | null,
): ExecutionTarget | null {
  const target = stringField(detail, "executionTarget");
  if (isExecutionTarget(target)) return target;

  const backend = stringField(detail, "backend");
  if (event.runtime === "workspace" && backend === "shell") return "worker-shell";
  if (event.runtime === "workspace" && backend === "container") return "computer-container";
  if (event.runtime === "sandbox" && toolForEvent(event, detail) === "exec") {
    return "sandbox-container";
  }
  return null;
}

function parseJsonObject(detail: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(detail) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function orderedEntries(value: Record<string, unknown>): [string, unknown][] {
  const preferred = preferredDetailFields
    .filter((field) => Object.hasOwn(value, field))
    .map((field): [string, unknown] => [field, value[field]]);
  const rest = Object.entries(value).filter(([field]) => !preferredDetailFields.includes(field));
  return [...preferred, ...rest];
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === "string" ? field : null;
}

function numberField(value: Record<string, unknown> | null, key: string): number | null {
  const field = value?.[key];
  return typeof field === "number" ? field : null;
}

function stringifyFieldValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isToolName(value: string | null): value is ToolName {
  return value !== null && toolNames.includes(value as ToolName);
}

function isExecutionTarget(value: string | null): value is ExecutionTarget {
  return (
    value === "worker-shell" || value === "computer-container" || value === "sandbox-container"
  );
}
