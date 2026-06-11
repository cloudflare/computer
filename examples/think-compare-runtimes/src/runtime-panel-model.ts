import type { RunEvent, RuntimeId } from "../shared/events";
import type { RuntimeDashboardModel } from "./dashboard-model";
import {
  execObservationFacts,
  factsForRuntime,
  type RunEventFact,
  readableDetail,
  trimWorkspaceRoot,
} from "./run-event-facts";

export type RuntimeEvidenceTone = "neutral" | "success" | "error";

export interface RuntimePanelModel {
  routingRows: RuntimeRoutingRow[];
  evidenceGroups: RuntimeEvidenceGroup[];
}

export interface RuntimeRoutingRow {
  label: string;
  value: string;
}

export interface RuntimeEvidenceGroup {
  id: string;
  title: string;
  summary: string;
  tone: RuntimeEvidenceTone;
  events: RunEvent[];
}

export function buildRuntimePanelModel(
  events: RunEvent[],
  runtime: RuntimeId,
  telemetry: RuntimeDashboardModel,
): RuntimePanelModel {
  const facts = factsForRuntime(events, runtime, "runtimeOnly");
  return {
    routingRows: routingRowsForRuntime(runtime, telemetry),
    evidenceGroups: evidenceGroupsForRuntime(runtime, facts),
  };
}

function routingRowsForRuntime(
  runtime: RuntimeId,
  telemetry: RuntimeDashboardModel,
): RuntimeRoutingRow[] {
  if (runtime === "workspace") {
    return [
      { label: "File tools", value: "durable storage" },
      { label: "Exec", value: "worker shell, then container when needed" },
      {
        label: "Observed",
        value: `${telemetry.workerShellExecs} shell · ${telemetry.containerExecs} container`,
      },
    ];
  }

  return [
    { label: "File tools + exec", value: "sandbox container" },
    { label: "Validation", value: validationLabel(telemetry.validationStatus) },
    { label: "Container", value: telemetry.container },
  ];
}

function evidenceGroupsForRuntime(
  runtime: RuntimeId,
  facts: RunEventFact[],
): RuntimeEvidenceGroup[] {
  const groups: RuntimeEvidenceGroup[] = [];
  const reads = facts.filter((fact) => fact.phase === "call" && fact.tool === "read");
  const edits = facts.filter((fact) => fact.phase === "call" && fact.tool === "edit");
  const writes = facts.filter((fact) => fact.phase === "call" && fact.tool === "write");
  const execs = execObservationFacts(facts);
  const finalMessage = [...facts].reverse().find((fact) => fact.phase === "message");
  const errors = facts.filter((fact) => fact.failed && fact.phase === "error");

  if (reads.length > 0) {
    groups.push(
      group(runtime, "reads", "Read source material", summarizePaths(reads), "neutral", reads),
    );
  }

  if (edits.length > 0) {
    groups.push(
      group(
        runtime,
        "edits",
        runtime === "workspace" ? "Edited durable files" : "Edited container files",
        summarizePaths(edits),
        "neutral",
        edits,
      ),
    );
  }

  if (writes.length > 0) {
    groups.push(
      group(
        runtime,
        "writes",
        runtime === "workspace" ? "Wrote durable files" : "Wrote container files",
        summarizePaths(writes),
        "neutral",
        writes,
      ),
    );
  }

  for (const exec of execs) {
    const title = exec.validationCommand
      ? "Ran container validation"
      : exec.executionTarget === "worker-shell"
        ? "Used worker shell"
        : "Used container exec";
    groups.push(
      group(
        runtime,
        `exec:${exec.sequence}`,
        title,
        exec.validationCommand
          ? `${exec.command ?? "exec"} · ${exec.failed ? "failed" : "passed"}`
          : (exec.command ?? "exec"),
        exec.failed ? "error" : exec.validationCommand ? "success" : "neutral",
        [exec],
      ),
    );
  }

  if (errors.length > 0) {
    groups.push(
      group(
        runtime,
        "errors",
        "Runtime needs attention",
        errors.map(readableDetail).join(" · "),
        "error",
        errors,
      ),
    );
  }

  if (finalMessage) {
    groups.push(
      group(runtime, "final", "Final response", readableDetail(finalMessage), "success", [
        finalMessage,
      ]),
    );
  }

  return groups;
}

function group(
  runtime: RuntimeId,
  id: string,
  title: string,
  summary: string,
  tone: RuntimeEvidenceTone,
  facts: RunEventFact[],
): RuntimeEvidenceGroup {
  return {
    id: `${runtime}:${id}`,
    title,
    summary,
    tone,
    events: facts.map((fact) => fact.event),
  };
}

function summarizePaths(facts: RunEventFact[]): string {
  const paths = facts
    .map((fact) => fact.path)
    .filter(isString)
    .map(trimWorkspaceRoot);
  if (paths.length === 0) return `${facts.length} operation${facts.length === 1 ? "" : "s"}`;
  const unique = [...new Set(paths)];
  if (unique.length <= 2) return unique.join(" · ");
  return `${unique.slice(0, 2).join(" · ")} · +${unique.length - 2} more`;
}

function validationLabel(status: RuntimeDashboardModel["validationStatus"]): string {
  return status === "not-run" ? "—" : status;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
