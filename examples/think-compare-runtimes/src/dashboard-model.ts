import type { RunEvent, RuntimeId } from "../shared/events";
import { deriveRunSummary, type OverallRunStatus, type RuntimeRunStatus } from "./run-state";

export type ContainerState = "off" | "booting" | "asleep" | "awake";

export type ValidationStatus = "not-run" | "passed" | "failed";

export interface RuntimeDashboardModel {
  id: RuntimeId;
  status: RuntimeRunStatus;
  elapsedLabel: string;
  toolCalls: number;
  fileOps: number;
  execCalls: number;
  workerShellExecs: number;
  containerExecs: number;
  validationStatus: ValidationStatus;
  container: ContainerState;
  error: string | null;
  events: RunEvent[];
}

export interface DashboardModel {
  run: {
    status: OverallRunStatus;
    elapsedLabel: string;
    actionLabel: "START RUN" | "RUN AGAIN";
  };
  runtimes: Record<RuntimeId, RuntimeDashboardModel>;
}

const runtimeIds: RuntimeId[] = ["workspace", "sandbox"];

export function buildDashboardModel(events: RunEvent[], nowIso: string | null): DashboardModel {
  const summary = deriveRunSummary(events);
  const sortedEvents = [...events].sort((left, right) => left.sequence - right.sequence);

  return {
    run: {
      status: summary.status,
      elapsedLabel: formatDuration(
        summary.elapsedMs ?? runningElapsedMs(summary.startedAt, summary.completedAt, nowIso),
      ),
      actionLabel:
        summary.status === "completed" || summary.status === "failed" ? "RUN AGAIN" : "START RUN",
    },
    runtimes: Object.fromEntries(
      runtimeIds.map((runtime) => {
        const runtimeSummary = summary.runtimes[runtime];
        const runtimeEvents = sortedEvents.filter((event) => event.runtime === runtime);
        const toolCalls = runtimeEvents.filter(isToolCall).length;
        const fileOps = runtimeEvents.filter(isFileCall).length;
        const execEvents = runtimeEvents.filter(isExecCall);
        const execCalls = execEvents.length;
        const workerShellExecs = execEvents.filter(
          (event) => execBackend(event) === "shell",
        ).length;
        const containerExecs = execEvents.filter(
          (event) => execBackend(event) === "container",
        ).length;

        return [
          runtime,
          {
            id: runtime,
            status: runtimeSummary.status,
            elapsedLabel: formatDuration(
              runtimeSummary.elapsedMs ??
                runningElapsedMs(runtimeSummary.startedAt, runtimeSummary.completedAt, nowIso),
            ),
            toolCalls,
            fileOps,
            execCalls,
            workerShellExecs,
            containerExecs: runtime === "workspace" ? containerExecs : execCalls,
            validationStatus: validationStatus(runtimeEvents),
            container: containerState(
              runtime,
              runtimeSummary.status,
              runtimeEvents,
              runtime === "workspace" ? containerExecs : execCalls,
            ),
            error: runtimeSummary.error,
            events: runtimeEvents,
          },
        ];
      }),
    ) as Record<RuntimeId, RuntimeDashboardModel>,
  };
}

function runningElapsedMs(
  startedAt: string | null,
  completedAt: string | null,
  nowIso: string | null,
): number | null {
  if (!startedAt || completedAt || !nowIso) return null;
  const elapsed = Date.parse(nowIso) - Date.parse(startedAt);
  return Number.isNaN(elapsed) ? null : Math.max(0, elapsed);
}

export function formatDuration(elapsedMs: number | null): string {
  if (elapsedMs === null) return "--:--";
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function isToolCall(event: RunEvent): boolean {
  return event.kind === "tool_call" || event.kind === "agent_tool_call";
}

function isFileCall(event: RunEvent): boolean {
  if (!isToolCall(event)) return false;
  const title = event.title.toLowerCase();
  return title.includes("read") || title.includes("write") || title.includes("edit");
}

function isExecCall(event: RunEvent): boolean {
  if (!isToolCall(event)) return false;
  if (event.title.toLowerCase().includes("exec")) return true;
  return typeof parsedDetail(event)?.command === "string";
}

function execBackend(event: RunEvent): string | null {
  const detail = parsedDetail(event);
  return typeof detail?.backend === "string" ? detail.backend : null;
}

function validationStatus(events: RunEvent[]): ValidationStatus {
  const validationExecs = events.filter((event) => {
    if (!isExecCall(event)) return false;
    const command = parsedDetail(event)?.command;
    return typeof command === "string" && /npm\s+run\s+check/.test(command);
  });
  if (validationExecs.length === 0) return "not-run";

  const failed = events.some((event) => {
    if (event.kind === "tool_error" || event.kind === "agent_tool_error") return true;
    const detail = parsedDetail(event);
    return typeof detail?.exitCode === "number" && detail.exitCode !== 0;
  });
  return failed ? "failed" : "passed";
}

function parsedDetail(event: RunEvent): Record<string, unknown> | null {
  try {
    const detail = JSON.parse(event.detail) as unknown;
    return detail && typeof detail === "object" ? (detail as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function containerState(
  runtime: RuntimeId,
  status: RuntimeRunStatus,
  events: RunEvent[],
  execCalls: number,
): ContainerState {
  if (runtime === "workspace") {
    return execCalls > 0 ? "awake" : "asleep";
  }

  if (status === "idle") return "off";
  if (
    events.some((event) => event.kind === "tool_call" || event.kind === "tool_result") ||
    execCalls > 0
  ) {
    return "awake";
  }
  return "booting";
}
