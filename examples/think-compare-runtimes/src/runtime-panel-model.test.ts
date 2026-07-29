import { describe, expect, test } from "vitest";
import type { RunEvent } from "../shared/events";
import { buildDashboardModel } from "./dashboard-model";
import { buildRuntimePanelModel } from "./runtime-panel-model";

describe("buildRuntimePanelModel", () => {
  test("builds Workspace substrate lanes from canonical event facts", () => {
    const events = [
      event({
        sequence: 0,
        runtime: "workspace",
        kind: "runtime_started",
        timestamp: "2026-06-04T00:00:00.000Z",
      }),
      event({
        sequence: 1,
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested read",
        detail: JSON.stringify({
          path: "/workspace/repo/feature-briefs/smart-request-policies.md",
        }),
        timestamp: "2026-06-04T00:00:01.000Z",
      }),
      event({
        sequence: 2,
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested exec",
        detail: JSON.stringify({ command: "grep -R Smart docs", cwd: "/workspace/repo" }),
        timestamp: "2026-06-04T00:00:02.000Z",
      }),
      event({
        sequence: 3,
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
        timestamp: "2026-06-04T00:00:03.000Z",
      }),
      event({
        sequence: 4,
        runtime: "workspace",
        kind: "agent_tool_result",
        title: "Think exec result",
        detail: JSON.stringify({
          command: "npm run check",
          cwd: "/workspace/repo",
          executionTarget: "computer-container",
          exitCode: 0,
          stdout: "docs check passed",
          stderr: "",
        }),
        timestamp: "2026-06-04T00:00:10.000Z",
      }),
      event({
        sequence: 5,
        runtime: "workspace",
        kind: "agent_message_delta",
        title: "Think response stream",
        detail: "I am checking the nav entry.",
        timestamp: "2026-06-04T00:00:11.000Z",
      }),
      event({
        sequence: 6,
        runtime: "workspace",
        kind: "agent_message",
        title: "Think turn complete",
        detail: "Updated the docs page, navigation, and Worker example.",
        timestamp: "2026-06-04T00:00:12.000Z",
      }),
    ];
    const telemetry = buildDashboardModel(events, "2026-06-04T00:00:12.000Z").runtimes.workspace;

    const model = buildRuntimePanelModel(events, "workspace", telemetry);

    expect(model.summary).toEqual([
      { label: "File ops", value: "1" },
      { label: "Dynamic worker", value: "1" },
      { label: "Container commands", value: "1" },
    ]);
    expect(model.lanes.map((lane) => lane.label)).toEqual(["VFS", "Dynamic worker", "Container"]);
    expect(model.lanes[0]?.markers.map((marker) => marker.label)).toEqual([
      "read feature-briefs/smart-request-policies.md",
    ]);
    expect(model.lanes[1]?.segments.map((segment) => segment.label)).toEqual([
      "grep -R Smart docs",
    ]);
    expect(model.lanes[2]?.segments.map((segment) => segment.label)).toEqual(["npm run check"]);
    expect(model.lanes[2]?.segments[0]?.status).toBe("passed");
    expect(model.workItems).toMatchObject([
      {
        kind: "read",
        label: "Read files",
        text: "1 file · feature-briefs/smart-request-policies.md",
        presentation: "compact",
      },
      {
        kind: "exec",
        label: "Ran command",
        command: "grep -R Smart docs",
        executionTarget: "worker-shell",
        exitCode: 0,
        presentation: "terminal",
      },
      {
        kind: "exec",
        label: "Ran command",
        command: "npm run check",
        executionTarget: "computer-container",
        exitCode: 0,
        presentation: "terminal",
      },
      {
        kind: "message",
        label: "Response",
        text: "I am checking the nav entry.\n\nUpdated the docs page, navigation, and Worker example.",
        presentation: "markdown",
      },
    ]);
    expect(model.transcript).toEqual([
      {
        id: "run-1:6",
        text: "Updated the docs page, navigation, and Worker example.",
        tone: "success",
      },
    ]);
  });

  test("groups interleaved thinking, reads, edits, and shell commands by intent", () => {
    const events = [
      event({
        sequence: 0,
        runtime: "workspace",
        kind: "runtime_started",
        timestamp: "2026-06-04T00:00:00.000Z",
      }),
      event({
        sequence: 1,
        runtime: "workspace",
        kind: "agent_thinking_delta",
        title: "Think reasoning stream",
        detail: "I need to locate the relevant docs.\n",
        timestamp: "2026-06-04T00:00:01.000Z",
      }),
      event({
        sequence: 2,
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested exec",
        detail: JSON.stringify({ command: "grep -R Smart docs", cwd: "/workspace/repo" }),
        timestamp: "2026-06-04T00:00:02.000Z",
      }),
      event({
        sequence: 3,
        runtime: "workspace",
        kind: "agent_tool_result",
        title: "Think exec result",
        detail: JSON.stringify({
          command: "grep -R Smart docs",
          cwd: "/workspace/repo",
          executionTarget: "worker-shell",
          exitCode: 0,
          stdout: "docs/workers/security.md:Smart Request Policies",
          stderr: "",
        }),
        timestamp: "2026-06-04T00:00:04.000Z",
      }),
      event({
        sequence: 4,
        runtime: "workspace",
        kind: "agent_thinking_delta",
        title: "Think reasoning stream",
        detail: "The grep result points at the security page.\n",
        timestamp: "2026-06-04T00:00:05.000Z",
      }),
      event({
        sequence: 5,
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested read",
        detail: JSON.stringify({ path: "/workspace/repo/README.md" }),
        timestamp: "2026-06-04T00:00:06.000Z",
      }),
      event({
        sequence: 6,
        runtime: "workspace",
        kind: "agent_tool_result",
        title: "Think read result",
        detail: JSON.stringify({ path: "/workspace/repo/README.md" }),
        timestamp: "2026-06-04T00:00:07.000Z",
      }),
      event({
        sequence: 7,
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested read",
        detail: JSON.stringify({ path: "/workspace/repo/docs/workers/security.md" }),
        timestamp: "2026-06-04T00:00:08.000Z",
      }),
      event({
        sequence: 8,
        runtime: "workspace",
        kind: "agent_tool_result",
        title: "Think read result",
        detail: JSON.stringify({ path: "/workspace/repo/docs/workers/security.md" }),
        timestamp: "2026-06-04T00:00:09.000Z",
      }),
      event({
        sequence: 9,
        runtime: "workspace",
        kind: "agent_thinking_delta",
        title: "Think reasoning stream",
        detail: "I have enough context to edit.\n",
        timestamp: "2026-06-04T00:00:10.000Z",
      }),
      event({
        sequence: 10,
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested edit",
        detail: JSON.stringify({ path: "/workspace/repo/docs/workers/security.md" }),
        timestamp: "2026-06-04T00:00:11.000Z",
      }),
      event({
        sequence: 11,
        runtime: "workspace",
        kind: "agent_tool_result",
        title: "Think edit result",
        detail: JSON.stringify({ path: "/workspace/repo/docs/workers/security.md" }),
        timestamp: "2026-06-04T00:00:12.000Z",
      }),
    ];
    const telemetry = buildDashboardModel(events, "2026-06-04T00:00:13.000Z").runtimes.workspace;

    const model = buildRuntimePanelModel(events, "workspace", telemetry);

    expect(model.workItems).toMatchObject([
      {
        kind: "thinking",
        label: "Thinking",
        text: "I need to locate the relevant docs.\nThe grep result points at the security page.\nI have enough context to edit.\n",
        presentation: "markdown",
      },
      {
        kind: "exec",
        label: "Ran command",
        command: "grep -R Smart docs",
        executionTarget: "worker-shell",
        exitCode: 0,
        stdout: "docs/workers/security.md:Smart Request Policies",
        presentation: "terminal",
      },
      {
        kind: "read",
        label: "Read files",
        count: 2,
        text: "2 files · README.md · docs/workers/security.md",
        presentation: "compact",
      },
      {
        kind: "edit",
        label: "Edited file",
        text: "docs/workers/security.md · applied",
        presentation: "compact",
      },
    ]);
  });

  test("starts a new thinking block after Think step boundaries", () => {
    const events = [
      event({
        sequence: 0,
        runtime: "workspace",
        kind: "agent_thinking_delta",
        title: "Think reasoning stream",
        detail: "First step reasoning.\n",
      }),
      event({
        sequence: 1,
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested exec",
        detail: JSON.stringify({ command: "grep -R Smart docs", cwd: "/workspace/repo" }),
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
        }),
      }),
      event({
        sequence: 3,
        runtime: "workspace",
        kind: "agent_thinking_delta",
        title: "Think reasoning stream",
        detail: "Still the first step after the tool result.\n",
      }),
      event({
        sequence: 4,
        runtime: "workspace",
        kind: "agent_step",
        title: "Think step finished",
        detail: "finishReason: tool-calls",
      }),
      event({
        sequence: 5,
        runtime: "workspace",
        kind: "agent_thinking_delta",
        title: "Think reasoning stream",
        detail: "Second step reasoning.\n",
      }),
    ];
    const telemetry = buildDashboardModel(events, "2026-06-04T00:00:13.000Z").runtimes.workspace;

    const model = buildRuntimePanelModel(events, "workspace", telemetry);

    expect(model.workItems).toMatchObject([
      {
        kind: "thinking",
        text: "First step reasoning.\nStill the first step after the tool result.\n",
      },
      { kind: "exec", command: "grep -R Smart docs" },
      { kind: "thinking", text: "Second step reasoning.\n" },
    ]);
  });

  test("ignores fixture instrumentation and incomplete unpaired tool calls in agent work", () => {
    const events = [
      event({
        sequence: 0,
        runtime: "workspace",
        kind: "tool_call",
        title: "write /workspace/repo/README.md",
        detail: "Writing fixture bytes through workspace runtime.",
      }),
      event({
        sequence: 1,
        runtime: "workspace",
        kind: "tool_result",
        title: "write complete",
        detail: "Wrote /workspace/repo/README.md.",
      }),
      event({
        sequence: 2,
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested exec",
        detail: JSON.stringify({}),
      }),
      event({
        sequence: 3,
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested write",
        detail: JSON.stringify({}),
      }),
    ];
    const telemetry = buildDashboardModel(events, "2026-06-04T00:00:13.000Z").runtimes.workspace;

    const model = buildRuntimePanelModel(events, "workspace", telemetry);

    expect(model.workItems).toEqual([]);
  });

  test("does not duplicate streamed assistant text when final text repeats it", () => {
    const events = [
      event({
        sequence: 0,
        runtime: "workspace",
        kind: "agent_message_delta",
        title: "Think response stream",
        detail: "I updated the docs and ran `npm run check`.",
      }),
      event({
        sequence: 1,
        runtime: "workspace",
        kind: "agent_message",
        title: "Think turn complete",
        detail: "I updated the docs and ran `npm run check`.",
      }),
    ];
    const telemetry = buildDashboardModel(events, "2026-06-04T00:00:13.000Z").runtimes.workspace;

    const model = buildRuntimePanelModel(events, "workspace", telemetry);

    expect(model.workItems).toMatchObject([
      {
        kind: "message",
        text: "I updated the docs and ran `npm run check`.",
        presentation: "markdown",
      },
    ]);
  });

  test("shows container assignment separately from command execution", () => {
    const events = [
      event({
        sequence: 0,
        runtime: "workspace",
        kind: "runtime_started",
        timestamp: "2026-06-04T00:00:00.000Z",
      }),
      event({
        sequence: 1,
        runtime: "workspace",
        kind: "container_acquired" as RunEvent["kind"],
        detail: JSON.stringify({
          executionTarget: "computer-container",
          containerId: "computer-container-1",
        }),
        timestamp: "2026-06-04T00:00:02.000Z",
      }),
      event({
        sequence: 2,
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested exec",
        detail: JSON.stringify({ command: "npm run check", cwd: "/workspace/repo" }),
        timestamp: "2026-06-04T00:00:05.000Z",
      }),
      event({
        sequence: 3,
        runtime: "workspace",
        kind: "agent_tool_result",
        title: "Think exec result",
        detail: JSON.stringify({
          command: "npm run check",
          cwd: "/workspace/repo",
          executionTarget: "computer-container",
          exitCode: 0,
          stdout: "docs check passed",
          stderr: "",
        }),
        timestamp: "2026-06-04T00:00:09.000Z",
      }),
      event({
        sequence: 4,
        runtime: "workspace",
        kind: "container_released" as RunEvent["kind"],
        detail: JSON.stringify({
          executionTarget: "computer-container",
          containerId: "computer-container-1",
        }),
        timestamp: "2026-06-04T00:00:12.000Z",
      }),
      event({
        sequence: 5,
        runtime: "workspace",
        kind: "container_release_scheduled" as RunEvent["kind"],
        detail: JSON.stringify({
          executionTarget: "computer-container",
          containerId: "computer-container-1",
          sleepAfterMs: 120_000,
        }),
        timestamp: "2026-06-04T00:00:12.000Z",
      }),
    ];
    const telemetry = buildDashboardModel(events, "2026-06-04T00:00:13.000Z").runtimes.workspace;

    const model = buildRuntimePanelModel(events, "workspace", telemetry);
    const containerLane = model.lanes.find((lane) => lane.id === "computer-container");

    expect(containerLane?.segments.map((segment) => [segment.label, segment.status])).toEqual([
      ["Container assigned", "lease"],
      ["npm run check", "passed"],
      ["Sleep-after", "residual"],
    ]);
    expect(containerLane?.segments[0]).toMatchObject({
      startMs: Date.parse("2026-06-04T00:00:02.000Z"),
      endMs: Date.parse("2026-06-04T00:00:12.000Z"),
    });
    expect(containerLane?.segments[2]).toMatchObject({
      startMs: Date.parse("2026-06-04T00:00:12.000Z"),
      endMs: Date.parse("2026-06-04T00:02:12.000Z"),
    });
  });

  test("extends an active container assignment to the latest runtime clock", () => {
    const events = [
      event({
        sequence: 0,
        runtime: "sandbox",
        kind: "runtime_started",
        timestamp: "2026-06-04T00:00:00.000Z",
      }),
      event({
        sequence: 1,
        runtime: "sandbox",
        kind: "container_acquired" as RunEvent["kind"],
        detail: JSON.stringify({ executionTarget: "sandbox-container" }),
        timestamp: "2026-06-04T00:00:03.000Z",
      }),
      event({
        sequence: 2,
        runtime: "sandbox",
        kind: "agent_thinking_delta",
        detail: "Still working.",
        timestamp: "2026-06-04T00:00:08.000Z",
      }),
    ];
    const telemetry = buildDashboardModel(events, "2026-06-04T00:00:13.000Z").runtimes.sandbox;

    const model = buildRuntimePanelModel(events, "sandbox", telemetry);
    const containerLane = model.lanes.find((lane) => lane.id === "container");

    expect(containerLane?.segments[0]).toMatchObject({
      label: "Container assigned",
      status: "lease",
      startMs: Date.parse("2026-06-04T00:00:03.000Z"),
      endMs: Date.parse("2026-06-04T00:00:08.000Z"),
    });
  });

  test("does not treat Think startup messages as final transcript", () => {
    const events = [
      event({
        sequence: 1,
        runtime: "workspace",
        kind: "agent_message",
        title: "Think turn started",
        detail: "Model-backed Think agent is running against the Workspace runtime.",
      }),
    ];
    const telemetry = buildDashboardModel(events, "2026-06-04T00:01:00.000Z").runtimes.workspace;

    const model = buildRuntimePanelModel(events, "workspace", telemetry);

    expect(model.transcript).toEqual([]);
  });

  test("builds Sandbox as a container substrate with validation failure", () => {
    const events = [
      event({
        sequence: 0,
        runtime: "sandbox",
        kind: "runtime_started",
        timestamp: "2026-06-04T00:00:00.000Z",
      }),
      event({
        sequence: 1,
        runtime: "sandbox",
        kind: "agent_tool_call",
        title: "Think requested write",
        detail: JSON.stringify({ path: "/workspace/repo/docs/workers/smart-request-policies.md" }),
        timestamp: "2026-06-04T00:00:03.000Z",
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
        timestamp: "2026-06-04T00:00:09.000Z",
      }),
    ];
    const telemetry = buildDashboardModel(events, "2026-06-04T00:01:00.000Z").runtimes.sandbox;

    const model = buildRuntimePanelModel(events, "sandbox", telemetry);

    expect(model.summary).toEqual([
      { label: "File ops", value: "1" },
      { label: "Container commands", value: "1" },
    ]);
    expect(model.lanes.map((lane) => lane.label)).toEqual(["VFS", "Dynamic worker", "Container"]);
    expect(model.lanes[0]?.markers).toEqual([]);
    expect(model.lanes[1]?.markers).toEqual([]);
    expect(model.lanes[2]?.markers.map((marker) => marker.label)).toEqual([
      "write docs/workers/smart-request-policies.md",
    ]);
    expect(model.lanes[2]?.segments.map((segment) => [segment.label, segment.status])).toEqual([
      ["Session setup", "neutral"],
      ["npm run check", "failed"],
    ]);
  });
});

function event(overrides: Partial<RunEvent> & { sequence: number }): RunEvent {
  return {
    id: `run-1:${overrides.sequence}`,
    runId: "run-1",
    sequence: overrides.sequence,
    runtime: overrides.runtime ?? "workspace",
    kind: overrides.kind ?? "runtime_note",
    title: overrides.title ?? "Event",
    detail: overrides.detail ?? "Detail",
    timestamp: overrides.timestamp ?? "1970-01-01T00:00:00.000Z",
  } as RunEvent;
}
