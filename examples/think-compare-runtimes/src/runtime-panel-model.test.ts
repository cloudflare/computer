import { describe, expect, test } from "vitest";
import type { RunEvent } from "../shared/events";
import { buildDashboardModel } from "./dashboard-model";
import { buildRuntimePanelModel } from "./runtime-panel-model";

describe("buildRuntimePanelModel", () => {
  test("builds Workspace routing and evidence from canonical event facts", () => {
    const events = [
      event({
        sequence: 1,
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested read",
        detail: JSON.stringify({
          path: "/workspace/repo/feature-briefs/smart-request-policies.md",
        }),
      }),
      event({
        sequence: 2,
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested edit",
        detail: JSON.stringify({ path: "/workspace/repo/docs/workers/configuration.md" }),
      }),
      event({
        sequence: 3,
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested exec",
        detail: JSON.stringify({
          command: "grep -R Smart docs",
          cwd: "/workspace/repo",
          executionTarget: "worker-shell",
        }),
      }),
      event({
        sequence: 4,
        runtime: "workspace",
        kind: "agent_tool_result",
        title: "Think exec result",
        detail: JSON.stringify({
          command: "grep -R Smart docs",
          cwd: "/workspace/repo",
          executionTarget: "worker-shell",
          exitCode: 0,
          stdout: "docs/workers/configuration.md:Smart Request Policies",
          stderr: "",
        }),
      }),
      event({
        sequence: 5,
        runtime: "workspace",
        kind: "agent_tool_result",
        title: "Think exec result",
        detail: JSON.stringify({
          command: "npm run check",
          cwd: "/workspace/repo",
          executionTarget: "workspace-container",
          exitCode: 0,
          stdout: "docs check passed",
          stderr: "",
        }),
      }),
      event({
        sequence: 6,
        runtime: "workspace",
        kind: "agent_message",
        title: "Think turn complete",
        detail: "Updated the docs page, navigation, and Worker example.",
      }),
    ];
    const telemetry = buildDashboardModel(events, "2026-06-04T00:01:00.000Z").runtimes.workspace;

    const model = buildRuntimePanelModel(events, "workspace", telemetry);

    expect(model.routingRows).toEqual([
      { label: "File tools", value: "durable storage" },
      { label: "Exec", value: "worker shell, then container when needed" },
      { label: "Observed", value: "1 shell · 1 container" },
    ]);
    expect(model.evidenceGroups.map((group) => group.title)).toEqual([
      "Read source material",
      "Edited durable files",
      "Used worker shell",
      "Ran container validation",
      "Final response",
    ]);
    expect(groupAt(model.evidenceGroups, 2).summary).toBe("grep -R Smart docs");
    expect(groupAt(model.evidenceGroups, 3).summary).toBe("npm run check · passed");
  });

  test("builds Sandbox routing and validation failure evidence", () => {
    const events = [
      event({
        sequence: 1,
        runtime: "sandbox",
        kind: "agent_tool_call",
        title: "Think requested write",
        detail: JSON.stringify({ path: "/workspace/repo/docs/workers/smart-request-policies.md" }),
      }),
      event({
        sequence: 2,
        runtime: "sandbox",
        kind: "agent_tool_result",
        title: "Think exec result",
        detail: JSON.stringify({
          command: "npm run check",
          cwd: "/workspace/repo",
          executionTarget: "sandbox-container",
          exitCode: 1,
          stdout: "",
          stderr: "Missing nav entry",
        }),
      }),
    ];
    const telemetry = buildDashboardModel(events, "2026-06-04T00:01:00.000Z").runtimes.sandbox;

    const model = buildRuntimePanelModel(events, "sandbox", telemetry);

    expect(model.routingRows).toEqual([
      { label: "File tools + exec", value: "sandbox container" },
      { label: "Validation", value: "failed" },
      { label: "Container", value: "awake" },
    ]);
    expect(model.evidenceGroups.map((group) => group.title)).toEqual([
      "Wrote container files",
      "Ran container validation",
    ]);
    expect(groupAt(model.evidenceGroups, 1).summary).toBe("npm run check · failed");
    expect(groupAt(model.evidenceGroups, 1).tone).toBe("error");
  });
});

function groupAt<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Missing item at index ${index}`);
  return item;
}

function event(overrides: Partial<RunEvent> & { sequence: number }): RunEvent {
  return {
    id: `run-1:${overrides.sequence}`,
    runId: "run-1",
    sequence: overrides.sequence,
    runtime: overrides.runtime ?? "workspace",
    kind: overrides.kind ?? "runtime_note",
    title: overrides.title ?? "Event",
    detail: overrides.detail ?? "Detail",
    timestamp: "1970-01-01T00:00:00.000Z",
  } as RunEvent;
}
