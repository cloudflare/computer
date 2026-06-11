import { describe, expect, test } from "vitest";
import type { RunEvent } from "../shared/events";
import { detailFieldsForEvent, factForEvent, factsForRuntime } from "./run-event-facts";

describe("run-event-facts", () => {
  test("normalizes tool names, phases, paths, commands, and execution targets", () => {
    const events = [
      event({
        sequence: 0,
        runtime: "both",
        kind: "run_started",
        title: "Run started",
        detail: "Starting.",
      }),
      event({
        sequence: 1,
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested read",
        detail: JSON.stringify({ path: "/workspace/repo/docs-nav.json" }),
      }),
      event({
        sequence: 2,
        runtime: "workspace",
        kind: "agent_tool_result",
        title: "Think exec result",
        detail: JSON.stringify({
          command: "grep -R Smart docs",
          cwd: "/workspace/repo",
          executionTarget: "worker-shell",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
      }),
      event({
        sequence: 3,
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

    expect(
      factsForRuntime(events, "workspace", "runtimeOnly").map((fact) => fact.sequence),
    ).toEqual([1, 2]);
    expect(
      factsForRuntime(events, "workspace", "runtimeOrShared").map((fact) => fact.sequence),
    ).toEqual([0, 1, 2]);

    const read = factForEvent(eventAt(events, 1));
    expect(read.tool).toBe("read");
    expect(read.phase).toBe("call");
    expect(read.path).toBe("/workspace/repo/docs-nav.json");

    const shell = factForEvent(eventAt(events, 2));
    expect(shell.tool).toBe("exec");
    expect(shell.phase).toBe("result");
    expect(shell.command).toBe("grep -R Smart docs");
    expect(shell.executionTarget).toBe("worker-shell");
    expect(shell.exitCode).toBe(0);
    expect(shell.validationCommand).toBe(false);

    const validation = factForEvent(eventAt(events, 3));
    expect(validation.executionTarget).toBe("sandbox-container");
    expect(validation.validationCommand).toBe(true);
    expect(validation.failed).toBe(true);
  });

  test("formats details through the same parsed fact", () => {
    const fields = detailFieldsForEvent(
      event({
        sequence: 1,
        runtime: "workspace",
        kind: "agent_tool_result",
        title: "Think exec result",
        detail: JSON.stringify({
          stdout: "ok\n",
          path: "/workspace/repo/docs/index.md",
          exitCode: 0,
          command: "npm run check",
          cwd: "/workspace/repo",
          executionTarget: "workspace-container",
        }),
      }),
    );

    expect(fields).toEqual([
      { label: "command", value: "npm run check" },
      { label: "path", value: "/workspace/repo/docs/index.md" },
      { label: "cwd", value: "/workspace/repo" },
      { label: "executionTarget", value: "workspace-container" },
      { label: "exitCode", value: "0" },
      { label: "stdout", value: "ok\n" },
    ]);
  });
});

function eventAt(events: RunEvent[], index: number): RunEvent {
  const item = events[index];
  if (item === undefined) throw new Error(`Missing event at index ${index}`);
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
