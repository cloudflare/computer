import { describe, expect, test } from "vitest";
import type { EventRuntime, RunEvent, RunEventKind } from "../shared/events";
import { applyRunMessage, deriveRunSummary } from "./run-state";

describe("applyRunMessage", () => {
  test("replaces history and appends live events", () => {
    const historyEvent = event({
      sequence: 0,
      runtime: "both",
      kind: "run_started",
      title: "Started",
      detail: "Initial history",
    });
    const liveEvent = { ...historyEvent, id: "run-1:1", sequence: 1 };

    const withHistory = applyRunMessage([], {
      type: "history",
      events: [historyEvent],
    });
    const withLiveEvent = applyRunMessage(withHistory, {
      type: "event",
      event: liveEvent,
    });

    expect(withHistory).toEqual([historyEvent]);
    expect(withLiveEvent).toEqual([historyEvent, liveEvent]);
  });

  test("derives per-runtime and overall terminal status", () => {
    const events = [
      event({
        sequence: 0,
        runtime: "both",
        kind: "run_started",
        title: "Comparison run started",
        timestamp: "2026-06-04T00:00:00.000Z",
      }),
      event({
        sequence: 1,
        runtime: "workspace",
        kind: "runtime_started",
        title: "Workspace started",
        timestamp: "2026-06-04T00:00:01.000Z",
      }),
      event({
        sequence: 2,
        runtime: "sandbox",
        kind: "runtime_started",
        title: "Sandbox started",
        timestamp: "2026-06-04T00:00:02.000Z",
      }),
      event({
        sequence: 3,
        runtime: "workspace",
        kind: "runtime_completed",
        title: "Workspace completed",
        timestamp: "2026-06-04T00:00:06.000Z",
      }),
      event({
        sequence: 4,
        runtime: "sandbox",
        kind: "runtime_failed",
        title: "Sandbox failed",
        detail: "3040: Capacity temporarily exceeded, please try again.",
        timestamp: "2026-06-04T00:00:08.500Z",
      }),
      event({
        sequence: 5,
        runtime: "both",
        kind: "run_completed",
        title: "Comparison run complete",
        timestamp: "2026-06-04T00:00:08.500Z",
      }),
    ];

    expect(deriveRunSummary(events)).toEqual({
      status: "failed",
      startedAt: "2026-06-04T00:00:00.000Z",
      completedAt: "2026-06-04T00:00:08.500Z",
      elapsedMs: 8500,
      runtimes: {
        workspace: {
          status: "completed",
          startedAt: "2026-06-04T00:00:01.000Z",
          completedAt: "2026-06-04T00:00:06.000Z",
          elapsedMs: 5000,
          error: null,
        },
        sandbox: {
          status: "failed",
          startedAt: "2026-06-04T00:00:02.000Z",
          completedAt: "2026-06-04T00:00:08.500Z",
          elapsedMs: 6500,
          error: "3040: Capacity temporarily exceeded, please try again.",
        },
      },
    });
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
