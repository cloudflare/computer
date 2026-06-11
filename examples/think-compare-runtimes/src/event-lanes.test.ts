import { describe, expect, test } from "vitest";
import type { RunEvent } from "../shared/events";
import { agentEventsForRuntime, formatEventDetail, runtimeEventsForRuntime } from "./event-lanes";

function event(overrides: Partial<RunEvent>): RunEvent {
  return {
    id: `run-1:${overrides.sequence ?? 0}`,
    runId: "run-1",
    sequence: overrides.sequence ?? 0,
    runtime: overrides.runtime ?? "workspace",
    kind: overrides.kind ?? "runtime_note",
    title: overrides.title ?? "Event",
    detail: overrides.detail ?? "Detail",
    timestamp: "1970-01-01T00:00:00.000Z",
  };
}

describe("runtime event lanes", () => {
  test("separates Think transcript events from runtime trace events", () => {
    const events = [
      event({ sequence: 0, runtime: "both", kind: "run_started" }),
      event({ sequence: 1, runtime: "workspace", kind: "agent_message" }),
      event({ sequence: 2, runtime: "workspace", kind: "agent_tool_call" }),
      event({ sequence: 3, runtime: "workspace", kind: "tool_call" }),
      event({ sequence: 4, runtime: "sandbox", kind: "agent_message" }),
    ];

    expect(agentEventsForRuntime(events, "workspace").map((item) => item.sequence)).toEqual([1, 2]);
    expect(runtimeEventsForRuntime(events, "workspace").map((item) => item.sequence)).toEqual([
      0, 3,
    ]);
    expect(agentEventsForRuntime(events, "sandbox").map((item) => item.sequence)).toEqual([4]);
    expect(runtimeEventsForRuntime(events, "sandbox").map((item) => item.sequence)).toEqual([0]);
  });

  test("formats JSON detail into prioritized structured fields", () => {
    const detail = formatEventDetail(
      JSON.stringify({
        stdout: "ok\n",
        path: "/workspace/repo/src/index.ts",
        exitCode: 0,
        command: "npm test",
        cwd: "/workspace/repo",
        stderr: "",
      }),
    );

    expect(detail).toEqual({
      text: null,
      fields: [
        { label: "command", value: "npm test" },
        { label: "path", value: "/workspace/repo/src/index.ts" },
        { label: "cwd", value: "/workspace/repo" },
        { label: "exitCode", value: "0" },
        { label: "stdout", value: "ok\n" },
        { label: "stderr", value: "" },
      ],
    });
  });

  test("keeps plain text details readable", () => {
    expect(formatEventDetail("Created /workspace/repo.")).toEqual({
      text: "Created /workspace/repo.",
      fields: [],
    });
  });
});
