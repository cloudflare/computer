import { describe, expect, test } from "vitest";
import type { EventRuntime, RunEvent, RunEventKind } from "../shared/events";
import { buildDashboardModel } from "./dashboard-model";

describe("buildDashboardModel", () => {
  test("derives idle telemetry before a run starts", () => {
    const model = buildDashboardModel([], null);

    expect(model.run.status).toBe("idle");
    expect(model.run.actionLabel).toBe("START RUN");
    expect(model.runtimes.workspace.container).toBe("asleep");
    expect(model.runtimes.sandbox.container).toBe("off");
    expect(model.runtimes.workspace.toolCalls).toBe(0);
    expect(model.runtimes.sandbox.execCalls).toBe(0);
  });

  test("shows Sandbox cold boot while Workspace is already active", () => {
    const model = buildDashboardModel(
      [
        event({
          sequence: 0,
          runtime: "both",
          kind: "run_started",
          timestamp: "2026-06-04T00:00:00.000Z",
        }),
        event({
          sequence: 1,
          runtime: "workspace",
          kind: "runtime_started",
          timestamp: "2026-06-04T00:00:01.000Z",
        }),
        event({
          sequence: 2,
          runtime: "workspace",
          kind: "tool_call",
          title: "read called",
          detail: JSON.stringify({ name: "read", path: "/workspace/repo/src/index.ts" }),
          timestamp: "2026-06-04T00:00:02.000Z",
        }),
        event({
          sequence: 3,
          runtime: "sandbox",
          kind: "runtime_started",
          timestamp: "2026-06-04T00:00:03.000Z",
        }),
      ],
      "2026-06-04T00:00:04.000Z",
    );

    expect(model.run.status).toBe("running");
    expect(model.run.elapsedLabel).toBe("00:04");
    expect(model.runtimes.workspace.status).toBe("running");
    expect(model.runtimes.workspace.elapsedLabel).toBe("00:03");
    expect(model.runtimes.workspace.toolCalls).toBe(1);
    expect(model.runtimes.workspace.fileOps).toBe(1);
    expect(model.runtimes.workspace.execCalls).toBe(0);
    expect(model.runtimes.workspace.workerShellExecs).toBe(0);
    expect(model.runtimes.workspace.containerExecs).toBe(0);
    expect(model.runtimes.workspace.container).toBe("asleep");
    expect(model.runtimes.sandbox.container).toBe("booting");
  });

  test("counts Workspace exec routing by backend", () => {
    const model = buildDashboardModel(
      [
        event({
          sequence: 0,
          runtime: "both",
          kind: "run_started",
          timestamp: "2026-06-04T00:00:00.000Z",
        }),
        event({
          sequence: 1,
          runtime: "workspace",
          kind: "runtime_started",
          timestamp: "2026-06-04T00:00:01.000Z",
        }),
        event({
          sequence: 2,
          runtime: "sandbox",
          kind: "runtime_started",
          timestamp: "2026-06-04T00:00:01.000Z",
        }),
        event({
          sequence: 3,
          runtime: "workspace",
          kind: "tool_call",
          title: "exec called",
          detail: JSON.stringify({
            command: "grep -R Smart docs",
            backend: "shell",
            cwd: "/workspace/repo",
          }),
          timestamp: "2026-06-04T00:00:05.000Z",
        }),
        event({
          sequence: 4,
          runtime: "workspace",
          kind: "tool_call",
          title: "exec called",
          detail: JSON.stringify({
            command: "npm run check",
            backend: "container",
            cwd: "/workspace/repo",
          }),
          timestamp: "2026-06-04T00:00:06.000Z",
        }),
        event({
          sequence: 5,
          runtime: "sandbox",
          kind: "agent_tool_call",
          title: "Think requested exec",
          detail: JSON.stringify({ command: "npm test", cwd: "/workspace/repo" }),
          timestamp: "2026-06-04T00:00:07.000Z",
        }),
      ],
      "2026-06-04T00:00:08.000Z",
    );

    expect(model.runtimes.workspace.toolCalls).toBe(2);
    expect(model.runtimes.workspace.execCalls).toBe(2);
    expect(model.runtimes.workspace.workerShellExecs).toBe(1);
    expect(model.runtimes.workspace.containerExecs).toBe(1);
    expect(model.runtimes.workspace.validationStatus).toBe("passed");
    expect(model.runtimes.workspace.container).toBe("awake");
    expect(model.runtimes.sandbox.toolCalls).toBe(1);
    expect(model.runtimes.sandbox.execCalls).toBe(1);
    expect(model.runtimes.sandbox.containerExecs).toBe(1);
    expect(model.runtimes.sandbox.container).toBe("awake");
  });

  test("uses terminal timestamps for completed runs", () => {
    const model = buildDashboardModel(
      [
        event({
          sequence: 0,
          runtime: "both",
          kind: "run_started",
          timestamp: "2026-06-04T00:00:00.000Z",
        }),
        event({
          sequence: 1,
          runtime: "workspace",
          kind: "runtime_started",
          timestamp: "2026-06-04T00:00:02.000Z",
        }),
        event({
          sequence: 2,
          runtime: "workspace",
          kind: "runtime_completed",
          timestamp: "2026-06-04T00:02:51.000Z",
        }),
        event({
          sequence: 3,
          runtime: "sandbox",
          kind: "runtime_started",
          timestamp: "2026-06-04T00:00:01.000Z",
        }),
        event({
          sequence: 4,
          runtime: "sandbox",
          kind: "runtime_completed",
          timestamp: "2026-06-04T00:03:42.000Z",
        }),
        event({
          sequence: 5,
          runtime: "both",
          kind: "run_completed",
          timestamp: "2026-06-04T00:03:42.000Z",
        }),
      ],
      "2026-06-04T00:10:00.000Z",
    );

    expect(model.run.status).toBe("completed");
    expect(model.run.actionLabel).toBe("RUN AGAIN");
    expect(model.run.elapsedLabel).toBe("03:42");
    expect(model.runtimes.workspace.elapsedLabel).toBe("02:49");
    expect(model.runtimes.sandbox.elapsedLabel).toBe("03:41");
  });
});

function event(overrides: Partial<RunEvent> & { sequence: number }): RunEvent {
  return {
    id: `run-1:${overrides.sequence}`,
    runId: "run-1",
    sequence: overrides.sequence,
    runtime: (overrides.runtime ?? "both") as EventRuntime,
    kind: (overrides.kind ?? "run_started") as RunEventKind,
    title: overrides.title ?? "Event",
    detail: overrides.detail ?? "Detail",
    timestamp: overrides.timestamp ?? "1970-01-01T00:00:00.000Z",
  };
}
