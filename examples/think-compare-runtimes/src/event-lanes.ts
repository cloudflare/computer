import type { RunEvent, RunEventKind, RuntimeId } from "../shared/events";

export interface EventDetailField {
  label: string;
  value: string;
}

export interface FormattedEventDetail {
  text: string | null;
  fields: EventDetailField[];
}

const agentEventKinds = new Set<RunEventKind>([
  "agent_message",
  "agent_tool_call",
  "agent_tool_result",
  "agent_tool_error",
]);

const preferredDetailFields = ["command", "path", "cwd", "exitCode", "stdout", "stderr", "error"];

export function agentEventsForRuntime(events: RunEvent[], runtime: RuntimeId): RunEvent[] {
  return events.filter(
    (event) => eventMatchesRuntime(event, runtime) && agentEventKinds.has(event.kind),
  );
}

export function runtimeEventsForRuntime(events: RunEvent[], runtime: RuntimeId): RunEvent[] {
  return events.filter(
    (event) => eventMatchesRuntime(event, runtime) && !agentEventKinds.has(event.kind),
  );
}

export function formatEventDetail(detail: string): FormattedEventDetail {
  const parsed = parseJsonObject(detail);
  if (parsed === null) {
    return { text: detail, fields: [] };
  }

  return {
    text: null,
    fields: orderedEntries(parsed).map(([label, value]) => ({
      label,
      value: stringifyFieldValue(value),
    })),
  };
}

function eventMatchesRuntime(event: RunEvent, runtime: RuntimeId): boolean {
  return event.runtime === runtime || event.runtime === "both";
}

function parseJsonObject(detail: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(detail) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}

  return null;
}

function orderedEntries(value: Record<string, unknown>): [string, unknown][] {
  const entries = Object.entries(value);
  const preferred = preferredDetailFields
    .filter((field) => Object.hasOwn(value, field))
    .map((field): [string, unknown] => [field, value[field]]);
  const rest = entries.filter(([field]) => !preferredDetailFields.includes(field));
  return [...preferred, ...rest];
}

function stringifyFieldValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
