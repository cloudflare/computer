import { describe, expect, test } from "vitest";
import { RunEventRecorder } from "./run-events";

describe("RunEventRecorder", () => {
  test("records ordered run events with generated IDs and timestamps", () => {
    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });

    const first = recorder.record({
      runtime: "workspace",
      kind: "tool_call",
      title: "write /workspace/repo/package.json",
      detail: "Writing fixture file",
    });
    const second = recorder.record({
      runtime: "workspace",
      kind: "tool_result",
      title: "write complete",
      detail: "Wrote fixture file",
    });

    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(1);
    expect(recorder.events()).toEqual([
      {
        id: "run-abc:0",
        runId: "run-abc",
        sequence: 0,
        runtime: "workspace",
        kind: "tool_call",
        title: "write /workspace/repo/package.json",
        detail: "Writing fixture file",
        timestamp: "2026-06-04T00:00:00.000Z",
      },
      {
        id: "run-abc:1",
        runId: "run-abc",
        sequence: 1,
        runtime: "workspace",
        kind: "tool_result",
        title: "write complete",
        detail: "Wrote fixture file",
        timestamp: "2026-06-04T00:00:00.000Z",
      },
    ]);
  });
});
