import type { RunEvent, RuntimeId } from "../shared/events";
import { execObservationFacts, factsForRuntime, type RunEventFact } from "./run-event-facts";
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
        const facts = factsForRuntime(events, runtime, "runtimeOnly");
        const execs = execObservationFacts(facts);
        const workerShellExecs = execs.filter(
          (fact) => fact.executionTarget === "worker-shell",
        ).length;
        const workspaceContainerExecs = execs.filter(
          (fact) => fact.executionTarget === "computer-container",
        ).length;
        const sandboxContainerExecs = execs.filter(
          (fact) => fact.executionTarget === "sandbox-container",
        ).length;
        const containerExecs =
          runtime === "workspace" ? workspaceContainerExecs : sandboxContainerExecs;

        return [
          runtime,
          {
            id: runtime,
            status: runtimeSummary.status,
            elapsedLabel: formatDuration(
              runtimeSummary.elapsedMs ??
                runningElapsedMs(runtimeSummary.startedAt, runtimeSummary.completedAt, nowIso),
            ),
            toolCalls: facts.filter((fact) => fact.phase === "call" && fact.tool !== null).length,
            fileOps: facts.filter(isFileCall).length,
            execCalls: execs.length,
            workerShellExecs,
            containerExecs,
            validationStatus: validationStatus(facts),
            container: containerState(runtime, runtimeSummary.status, facts, containerExecs),
            error: runtimeSummary.error,
            events: facts.map((fact) => fact.event),
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

function isFileCall(fact: RunEventFact): boolean {
  return (
    fact.phase === "call" && (fact.tool === "read" || fact.tool === "write" || fact.tool === "edit")
  );
}

function validationStatus(facts: RunEventFact[]): ValidationStatus {
  const latestValidation = execObservationFacts(facts)
    .filter((fact) => fact.validationCommand)
    .at(-1);
  if (!latestValidation) return "not-run";
  return latestValidation.failed ? "failed" : "passed";
}

function containerState(
  runtime: RuntimeId,
  status: RuntimeRunStatus,
  facts: RunEventFact[],
  containerExecs: number,
): ContainerState {
  if (runtime === "workspace") {
    return containerExecs > 0 ? "awake" : "asleep";
  }

  if (status === "idle") return "off";
  if (
    facts.some((fact) => fact.phase === "call" || fact.phase === "result") ||
    containerExecs > 0
  ) {
    return "awake";
  }
  return "booting";
}
