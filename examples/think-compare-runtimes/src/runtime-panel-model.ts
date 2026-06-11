import type { ExecutionTarget, RunEvent, RuntimeId } from "../shared/events";
import type { RuntimeDashboardModel } from "./dashboard-model";
import { factForEvent, factsForRuntime, trimWorkspaceRoot } from "./run-event-facts";

export type TimelineTone = "vfs" | "dynamic-worker" | "container" | "agent" | "error";
export type SegmentStatus = "running" | "passed" | "failed" | "neutral" | "lease" | "residual";

export interface RuntimePanelModel {
  statusLine: string;
  summary: RuntimeSummaryItem[];
  lanes: TimelineLane[];
  transcript: TranscriptItem[];
  workItems: AgentWorkItem[];
  clock: RuntimeClock;
}

export interface RuntimeSummaryItem {
  label: string;
  value: string;
}

export interface RuntimeClock {
  startMs: number | null;
  endMs: number | null;
  durationLabel: string;
}

export interface TimelineLane {
  id: string;
  label: string;
  tone: TimelineTone;
  segments: TimelineSegment[];
  markers: TimelineMarker[];
}

export interface TimelineSegment {
  id: string;
  startMs: number;
  endMs: number;
  label: string;
  status: SegmentStatus;
}

export interface TimelineMarker {
  id: string;
  atMs: number;
  label: string;
  status: SegmentStatus;
}

export interface TranscriptItem {
  id: string;
  text: string;
  tone: "neutral" | "success" | "error";
}

export interface AgentWorkItem {
  id: string;
  kind: "thinking" | "message" | "read" | "write" | "edit" | "exec" | "error" | "step";
  label: string;
  text: string;
  tone: "neutral" | "success" | "error" | "stream";
  presentation: "markdown" | "compact" | "terminal";
  count?: number;
  command?: string;
  cwd?: string;
  executionTarget?: ExecutionTarget;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export function buildRuntimePanelModel(
  events: RunEvent[],
  runtime: RuntimeId,
  telemetry: RuntimeDashboardModel,
): RuntimePanelModel {
  const runtimeEvents = factsForRuntime(events, runtime, "runtimeOnly").map((fact) => fact.event);
  const clock = runtimeClock(runtimeEvents, telemetry);
  const lanes =
    runtime === "workspace" ? workspaceLanes(runtimeEvents) : sandboxLanes(runtimeEvents);

  return {
    statusLine: statusLine(telemetry),
    summary: summaryItems(runtime, telemetry),
    lanes,
    transcript: transcriptItems(runtimeEvents),
    workItems: workItems(runtimeEvents),
    clock,
  };
}

function workspaceLanes(events: RunEvent[]): TimelineLane[] {
  return [
    {
      id: "vfs",
      label: "VFS",
      tone: "vfs",
      segments: [],
      markers: fileMarkers(events, "vfs"),
    },
    {
      id: "dynamic-worker",
      label: "Dynamic worker",
      tone: "dynamic-worker",
      segments: execSegments(events, "worker-shell"),
      markers: [],
    },
    {
      id: "workspace-container",
      label: "Container",
      tone: "container",
      segments: containerSegments(events, "workspace-container"),
      markers: [],
    },
  ];
}

function sandboxLanes(events: RunEvent[]): TimelineLane[] {
  const firstWork = firstWorkTimestamp(events);
  const started = events.find((event) => event.kind === "runtime_started");
  const bootSegment =
    started && firstWork && firstWork > Date.parse(started.timestamp)
      ? [
          {
            id: "sandbox:boot",
            startMs: Date.parse(started.timestamp),
            endMs: firstWork,
            label: "Session setup",
            status: "neutral" as const,
          },
        ]
      : [];

  return [
    {
      id: "vfs",
      label: "VFS",
      tone: "vfs",
      segments: [],
      markers: [],
    },
    {
      id: "dynamic-worker",
      label: "Dynamic worker",
      tone: "dynamic-worker",
      segments: [],
      markers: [],
    },
    {
      id: "container",
      label: "Container",
      tone: "container",
      segments: [...bootSegment, ...containerSegments(events, "sandbox-container")],
      markers: fileMarkers(events, "container"),
    },
  ];
}

function fileMarkers(events: RunEvent[], _tone: TimelineTone): TimelineMarker[] {
  return events.flatMap((event) => {
    const fact = factForEvent(event);
    if (
      fact.phase !== "call" ||
      (fact.tool !== "read" && fact.tool !== "write" && fact.tool !== "edit")
    ) {
      return [];
    }
    return [
      {
        id: event.id,
        atMs: Date.parse(event.timestamp),
        label: `${fact.tool} ${fact.path ? trimWorkspaceRoot(fact.path) : "file"}`,
        status: "neutral" as const,
      },
    ];
  });
}

function containerSegments(events: RunEvent[], target: ExecutionTarget): TimelineSegment[] {
  return [...containerLeaseSegments(events, target), ...execSegments(events, target)].sort(
    (left, right) =>
      left.startMs - right.startMs || segmentOrder(left.status) - segmentOrder(right.status),
  );
}

function containerLeaseSegments(events: RunEvent[], target: ExecutionTarget): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  const acquisitions: RunEvent[] = [];
  const fallbackEndMs = latestEventTimestamp(events);

  for (const event of events) {
    const detail = containerLifecycleDetail(event);
    if (!detail || detail.executionTarget !== target) continue;

    if (event.kind === "container_acquired") {
      acquisitions.push(event);
      continue;
    }

    if (event.kind === "container_released") {
      const acquired = acquisitions.shift();
      if (!acquired) continue;
      segments.push({
        id: `${acquired.id}:lease`,
        startMs: Date.parse(acquired.timestamp),
        endMs: Date.parse(event.timestamp),
        label: "Container assigned",
        status: "lease",
      });
      continue;
    }

    if (event.kind === "container_release_scheduled" && detail.sleepAfterMs > 0) {
      const startMs = Date.parse(event.timestamp);
      segments.push({
        id: `${event.id}:residual`,
        startMs,
        endMs: startMs + detail.sleepAfterMs,
        label: "Sleep-after",
        status: "residual",
      });
    }
  }

  for (const acquired of acquisitions) {
    const startMs = Date.parse(acquired.timestamp);
    segments.push({
      id: `${acquired.id}:lease`,
      startMs,
      endMs: Math.max(startMs, fallbackEndMs ?? startMs),
      label: "Container assigned",
      status: "lease",
    });
  }

  return segments;
}

function execSegments(events: RunEvent[], target: ExecutionTarget): TimelineSegment[] {
  const calls = new Map<string, RunEvent[]>();
  const segments: TimelineSegment[] = [];

  for (const event of events) {
    const fact = factForEvent(event);
    if (fact.tool !== "exec" || !fact.command) continue;
    if (fact.phase === "call") {
      const existing = calls.get(fact.command) ?? [];
      existing.push(event);
      calls.set(fact.command, existing);
      continue;
    }
    if ((fact.phase !== "result" && fact.phase !== "error") || fact.executionTarget !== target)
      continue;

    const call = calls.get(fact.command)?.shift();
    const endMs = Date.parse(event.timestamp);
    const startMs = call ? Date.parse(call.timestamp) : endMs;
    segments.push({
      id: event.id,
      startMs,
      endMs: Math.max(startMs, endMs),
      label: fact.validationCommand ? "npm run check" : fact.command,
      status: fact.failed ? "failed" : fact.validationCommand ? "passed" : "neutral",
    });
  }

  return segments;
}

function segmentOrder(status: SegmentStatus): number {
  if (status === "lease") return 0;
  if (status === "residual") return 1;
  return 2;
}

function containerLifecycleDetail(
  event: RunEvent,
): { executionTarget: ExecutionTarget; sleepAfterMs: number } | null {
  if (
    event.kind !== "container_acquired" &&
    event.kind !== "container_released" &&
    event.kind !== "container_release_scheduled"
  ) {
    return null;
  }
  const fact = factForEvent(event);
  if (!fact.executionTarget) return null;
  return {
    executionTarget: fact.executionTarget,
    sleepAfterMs: numberDetail(fact, "sleepAfterMs") ?? 0,
  };
}

function numberDetail(fact: ReturnType<typeof factForEvent>, key: string): number | null {
  const value = fact.detail?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function latestEventTimestamp(events: RunEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const parsed = Date.parse(events[index]?.timestamp ?? "");
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function firstWorkTimestamp(events: RunEvent[]): number | null {
  const first = events.find((event) => {
    const fact = factForEvent(event);
    return fact.phase === "call" || fact.phase === "result" || fact.phase === "error";
  });
  if (!first) return null;
  const parsed = Date.parse(first.timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

function workItems(events: RunEvent[]): AgentWorkItem[] {
  const items: AgentWorkItem[] = [];
  const streamItems = new Map<"thinking" | "message", AgentWorkItem>();
  const pendingToolCalls = new Map<string, ReturnType<typeof factForEvent>[]>();
  let readAggregate: { event: RunEvent; count: number; paths: string[] } | null = null;

  const flushReads = () => {
    if (!readAggregate) return;
    const preview = readAggregate.paths.slice(0, 3).join(" · ");
    const suffix =
      readAggregate.paths.length > 3 ? ` · +${readAggregate.paths.length - 3} more` : "";
    items.push({
      id: readAggregate.event.id,
      kind: "read",
      label: "Read files",
      text: `${readAggregate.count} file${readAggregate.count === 1 ? "" : "s"}${preview ? ` · ${preview}${suffix}` : ""}`,
      tone: "neutral",
      presentation: "compact",
      count: readAggregate.count,
    });
    readAggregate = null;
  };

  const appendStream = (event: RunEvent, kind: "thinking" | "message", label: string) => {
    const existing = streamItems.get(kind);
    if (existing) {
      existing.text += event.detail;
      return;
    }
    flushReads();
    const created: AgentWorkItem = {
      id: event.id,
      kind,
      label,
      text: event.detail,
      tone: "stream",
      presentation: "markdown",
    };
    items.push(created);
    streamItems.set(kind, created);
  };

  const appendFinalMessage = (event: RunEvent) => {
    const existing = streamItems.get("message");
    if (existing) {
      const streamed = existing.text.trim();
      const final = event.detail.trim();
      existing.text =
        streamed === final || streamed.includes(final)
          ? streamed
          : [streamed, final].filter(Boolean).join("\n\n");
      existing.tone = "success";
      return;
    }
    flushReads();
    items.push({
      id: event.id,
      kind: "message",
      label: "Final response",
      text: event.detail,
      tone: "success",
      presentation: "markdown",
    });
  };

  for (const event of events) {
    const fact = factForEvent(event);

    if (event.kind === "agent_thinking_delta") {
      appendStream(event, "thinking", "Thinking");
      continue;
    }
    if (event.kind === "agent_message_delta") {
      appendStream(event, "message", "Response");
      continue;
    }
    if (event.kind === "agent_step") {
      streamItems.delete("thinking");
      continue;
    }
    if (event.kind === "agent_message" && event.title === "Think turn started") {
      continue;
    }
    if (event.kind === "agent_message" && event.title === "Think turn complete") {
      appendFinalMessage(event);
      continue;
    }
    if (event.kind === "runtime_failed") {
      flushReads();
      items.push({
        id: event.id,
        kind: "error",
        label: "Needs attention",
        text: event.detail,
        tone: "error",
        presentation: "markdown",
      });
      continue;
    }
    if (!isAgentToolLifecycleEvent(event)) {
      continue;
    }

    if (fact.tool === "read" && fact.phase === "error") {
      flushReads();
      items.push({
        id: event.id,
        kind: "error",
        label: "Read failed",
        text: event.detail,
        tone: "error",
        presentation: "markdown",
      });
      continue;
    }
    if (fact.tool === "read" && fact.phase === "call") {
      readAggregate ??= { event, count: 0, paths: [] };
      readAggregate.count += 1;
      if (fact.path) readAggregate.paths.push(trimWorkspaceRoot(fact.path));
      continue;
    }
    if (fact.tool === "read") {
      continue;
    }

    if (fact.phase === "call") {
      queuePendingToolCall(pendingToolCalls, fact);
      continue;
    }

    flushReads();
    if (fact.tool === "exec") {
      items.push(execItem(fact, takePendingToolCall(pendingToolCalls, fact)));
      continue;
    }
    if (fact.tool === "edit" || fact.tool === "write") {
      items.push(fileMutationItem(fact, takePendingToolCall(pendingToolCalls, fact)));
    }
  }

  flushReads();
  appendConcreteUnpairedToolCalls(items, pendingToolCalls);
  return items;
}

function isAgentToolLifecycleEvent(event: RunEvent): boolean {
  return (
    event.kind === "agent_tool_call" ||
    event.kind === "agent_tool_result" ||
    event.kind === "agent_tool_error"
  );
}

function queuePendingToolCall(
  pending: Map<string, ReturnType<typeof factForEvent>[]>,
  fact: ReturnType<typeof factForEvent>,
) {
  const key = toolPairKey(fact);
  const calls = pending.get(key) ?? [];
  calls.push(fact);
  pending.set(key, calls);
}

function takePendingToolCall(
  pending: Map<string, ReturnType<typeof factForEvent>[]>,
  fact: ReturnType<typeof factForEvent>,
): ReturnType<typeof factForEvent> | null {
  return pending.get(toolPairKey(fact))?.shift() ?? null;
}

function toolPairKey(fact: ReturnType<typeof factForEvent>): string {
  return `${fact.tool ?? "tool"}:${fact.command ?? fact.path ?? fact.event.sequence}`;
}

function execItem(
  fact: ReturnType<typeof factForEvent>,
  call: ReturnType<typeof factForEvent> | null,
): AgentWorkItem {
  const command = fact.command ?? call?.command ?? "command";
  const target = fact.executionTarget ?? call?.executionTarget ?? undefined;
  const stdout = stringDetail(fact, "stdout");
  const stderr = stringDetail(fact, "stderr");
  const exit = typeof fact.exitCode === "number" ? ` · exit ${fact.exitCode}` : "";
  const targetLabel = target ? ` · ${executionTargetLabel(target)}` : "";
  return {
    id: fact.event.id,
    kind: "exec",
    label: fact.failed ? "Command failed" : "Ran command",
    text: `${command}${targetLabel}${exit}`,
    tone: fact.failed ? "error" : "success",
    presentation: "terminal",
    command,
    cwd: fact.cwd ?? call?.cwd ?? undefined,
    executionTarget: target,
    exitCode: fact.exitCode ?? undefined,
    stdout: stdout ?? undefined,
    stderr: stderr ?? undefined,
  };
}

function fileMutationItem(
  fact: ReturnType<typeof factForEvent>,
  call: ReturnType<typeof factForEvent> | null,
): AgentWorkItem {
  const kind = fact.tool === "write" ? "write" : "edit";
  const path = fact.path ?? call?.path;
  const displayPath = path ? trimWorkspaceRoot(path) : "file";
  const label = kind === "write" ? "Wrote file" : "Edited file";
  const status = fact.failed ? "failed" : "applied";
  return {
    id: fact.event.id,
    kind,
    label: fact.failed ? `${label} failed` : label,
    text: `${displayPath} · ${status}`,
    tone: fact.failed ? "error" : "success",
    presentation: "compact",
  };
}

function appendConcreteUnpairedToolCalls(
  items: AgentWorkItem[],
  pending: Map<string, ReturnType<typeof factForEvent>[]>,
) {
  for (const calls of pending.values()) {
    for (const fact of calls) {
      if (fact.tool === "exec" && fact.command) {
        items.push({
          id: fact.event.id,
          kind: "exec",
          label: "Command requested",
          text: fact.command,
          tone: "neutral",
          presentation: "terminal",
          command: fact.command,
          cwd: fact.cwd ?? undefined,
          executionTarget: fact.executionTarget ?? undefined,
        });
      } else if ((fact.tool === "edit" || fact.tool === "write") && fact.path) {
        items.push({
          id: fact.event.id,
          kind: fact.tool,
          label: fact.tool === "write" ? "Write requested" : "Edit requested",
          text: trimWorkspaceRoot(fact.path),
          tone: "neutral",
          presentation: "compact",
        });
      }
    }
  }
}

function stringDetail(fact: ReturnType<typeof factForEvent>, key: string): string | null {
  const value = fact.detail?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function executionTargetLabel(target: ExecutionTarget): string {
  if (target === "worker-shell") return "worker shell";
  if (target === "workspace-container") return "workspace container";
  return "sandbox";
}

function transcriptItems(events: RunEvent[]): TranscriptItem[] {
  const final = [...events]
    .reverse()
    .find((event) => event.kind === "agent_message" && event.title === "Think turn complete");
  const failure = [...events]
    .reverse()
    .find((event) => event.kind === "runtime_failed" || event.kind === "agent_tool_error");

  if (failure) {
    return [{ id: failure.id, text: failure.detail, tone: "error" }];
  }
  if (final) {
    return [{ id: final.id, text: final.detail, tone: "success" }];
  }
  return [];
}

function runtimeClock(events: RunEvent[], telemetry: RuntimeDashboardModel): RuntimeClock {
  const start = events.find((event) => event.kind === "runtime_started") ?? events[0] ?? null;
  const terminal = [...events]
    .reverse()
    .find((event) => event.kind === "runtime_completed" || event.kind === "runtime_failed");
  const last = events.at(-1) ?? null;
  const startMs = parseTimestamp(start?.timestamp ?? null);
  const endMs = parseTimestamp(terminal?.timestamp ?? last?.timestamp ?? null);
  return {
    startMs,
    endMs,
    durationLabel: telemetry.elapsedLabel,
  };
}

function summaryItems(runtime: RuntimeId, telemetry: RuntimeDashboardModel): RuntimeSummaryItem[] {
  if (runtime === "workspace") {
    return [
      { label: "File ops", value: String(telemetry.fileOps) },
      { label: "Dynamic worker", value: String(telemetry.workerShellExecs) },
      { label: "Container commands", value: String(telemetry.containerExecs) },
    ];
  }

  return [
    { label: "File ops", value: String(telemetry.fileOps) },
    { label: "Container commands", value: String(telemetry.containerExecs) },
  ];
}

function statusLine(telemetry: RuntimeDashboardModel): string {
  if (telemetry.status === "idle") return "Ready";
  if (telemetry.status === "running") return `Running · ${telemetry.elapsedLabel}`;
  if (telemetry.status === "completed") return `Completed · ${telemetry.elapsedLabel}`;
  return `Failed · ${telemetry.elapsedLabel}`;
}

function parseTimestamp(timestamp: string | null): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}
