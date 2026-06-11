import type { RunEvent, RuntimeId } from "../shared/events";

export type RunMessage =
  | {
      type: "history";
      events: RunEvent[];
    }
  | {
      type: "event";
      event: RunEvent;
    };

export type RuntimeRunStatus = "idle" | "running" | "completed" | "failed";
export type OverallRunStatus = RuntimeRunStatus;

export interface RuntimeRunSummary {
  status: RuntimeRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  elapsedMs: number | null;
  error: string | null;
}

export interface RunSummary {
  status: OverallRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  elapsedMs: number | null;
  runtimes: Record<RuntimeId, RuntimeRunSummary>;
}

const runtimeIds: RuntimeId[] = ["workspace", "sandbox"];

export function applyRunMessage(events: RunEvent[], message: RunMessage): RunEvent[] {
  if (message.type === "history") {
    return [...message.events].sort(bySequence);
  }

  return [...events, message.event].sort(bySequence);
}

export function deriveRunSummary(events: RunEvent[]): RunSummary {
  const sorted = [...events].sort(bySequence);
  const runStarted = sorted.find((event) => event.kind === "run_started") ?? null;
  const runCompleted = findLast(sorted, (event) => event.kind === "run_completed");
  const runtimes = Object.fromEntries(
    runtimeIds.map((runtime) => [runtime, deriveRuntimeSummary(sorted, runtime)]),
  ) as Record<RuntimeId, RuntimeRunSummary>;
  const hasRuntimeFailure = runtimeIds.some((runtime) => runtimes[runtime].status === "failed");

  const status: OverallRunStatus = runStarted
    ? hasRuntimeFailure
      ? "failed"
      : runCompleted
        ? "completed"
        : "running"
    : "idle";
  const startedAt = runStarted?.timestamp ?? null;
  const completedAt =
    runCompleted?.timestamp ??
    (allRuntimesTerminal(runtimes) ? terminalCompletionTime(runtimes) : null);

  return {
    status,
    startedAt,
    completedAt,
    elapsedMs: elapsedMs(startedAt, completedAt),
    runtimes,
  };
}

function deriveRuntimeSummary(events: RunEvent[], runtime: RuntimeId): RuntimeRunSummary {
  const runtimeEvents = events.filter((event) => event.runtime === runtime);
  const started = runtimeEvents.find((event) => event.kind === "runtime_started") ?? null;
  const completed = findLast(runtimeEvents, (event) => event.kind === "runtime_completed");
  const failed = findLast(
    runtimeEvents,
    (event) =>
      event.kind === "runtime_failed" ||
      (event.kind === "agent_tool_error" && event.title === "Think agent failed"),
  );
  const startedAt = started?.timestamp ?? runtimeEvents[0]?.timestamp ?? null;
  const completedAt = failed?.timestamp ?? completed?.timestamp ?? null;

  return {
    status: failed ? "failed" : completed ? "completed" : startedAt ? "running" : "idle",
    startedAt,
    completedAt,
    elapsedMs: elapsedMs(startedAt, completedAt),
    error: failed?.detail ?? null,
  };
}

function allRuntimesTerminal(runtimes: Record<RuntimeId, RuntimeRunSummary>): boolean {
  return runtimeIds.every((runtime) => {
    const status = runtimes[runtime].status;
    return status === "completed" || status === "failed";
  });
}

function terminalCompletionTime(runtimes: Record<RuntimeId, RuntimeRunSummary>): string | null {
  const completedTimes = runtimeIds
    .map((runtime) => runtimes[runtime].completedAt)
    .filter((timestamp): timestamp is string => timestamp !== null)
    .sort();
  return completedTimes.at(-1) ?? null;
}

function elapsedMs(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isNaN(elapsed) ? null : elapsed;
}

function findLast<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return undefined;
}

function bySequence(left: RunEvent, right: RunEvent): number {
  return left.sequence - right.sequence;
}
