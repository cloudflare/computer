import { Button } from "@cloudflare/kumo/components/button";
import { usePartySocket } from "partysocket/react";
import { useEffect, useMemo, useState } from "react";
import type { RunEvent, RuntimeId } from "../shared/events";
import { comparisonFixture } from "../shared/fixture";
import { AutoScrollList } from "./auto-scroll-list";
import {
  buildDashboardModel,
  type ContainerState,
  type RuntimeDashboardModel,
} from "./dashboard-model";
import { agentEventsForRuntime, formatEventDetail, runtimeEventsForRuntime } from "./event-lanes";
import { MarkdownText } from "./markdown-text";
import { applyRunMessage, type RunMessage } from "./run-state";

interface RunSessionResponse {
  runId: string;
  socketPath: string;
  events: RunEvent[];
}

type StartState = "idle" | "starting" | "running" | "failed";

type WingMode = "idle" | "boot" | "activity";

const runtimeCopy: Record<
  RuntimeId,
  {
    side: "L" | "R";
    label: "WORKSPACE" | "SANDBOX";
    packageName: string;
    title: string;
    subtitle: string;
    accent: string;
    dot: string;
  }
> = {
  workspace: {
    side: "L",
    label: "WORKSPACE",
    packageName: "@cloudflare/workspace",
    title: "Durable files + routed exec",
    subtitle:
      "Direct file tools use durable storage. Exec routes to the worker shell first, then container for real binaries.",
    accent: "text-[#F2A93B]",
    dot: "bg-[#F2A93B]",
  },
  sandbox: {
    side: "R",
    label: "SANDBOX",
    packageName: "@cloudflare/sandbox",
    title: "Container filesystem",
    subtitle: "Same fixture is seeded into the Sandbox filesystem. File tools and exec run there.",
    accent: "text-[#5BC8A7]",
    dot: "bg-[#5BC8A7]",
  },
};

const statusTone = {
  idle: "border-[#22272E] bg-[#171A1F] text-[#8A9099]",
  running: "border-[#F2A93B]/40 bg-[#F2A93B]/10 text-[#F2A93B]",
  completed: "border-[#5BC8A7]/40 bg-[#5BC8A7]/10 text-[#5BC8A7]",
  failed: "border-[#E15B5B]/45 bg-[#E15B5B]/10 text-[#E15B5B]",
};

const containerTone: Record<ContainerState, string> = {
  off: "text-[#8A9099]",
  asleep: "text-[#8A9099]",
  booting: "text-[#5BC8A7]",
  awake: "text-[#E6E8EA]",
};

export function App() {
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [startState, setStartState] = useState<StartState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [nowIso, setNowIso] = useState(() => new Date().toISOString());

  usePartySocket({
    party: "compare-run",
    room: runId ?? "idle",
    enabled: runId !== null,
    onMessage(message) {
      const parsed = JSON.parse(String(message.data)) as RunMessage;
      setEvents((current) => applyRunMessage(current, parsed));
    },
  });

  const dashboard = useMemo(() => buildDashboardModel(events, nowIso), [events, nowIso]);
  const lanesByRuntime = useMemo(
    () => ({
      workspace: {
        agent: agentEventsForRuntime(events, "workspace"),
        runtime: runtimeEventsForRuntime(events, "workspace"),
      },
      sandbox: {
        agent: agentEventsForRuntime(events, "sandbox"),
        runtime: runtimeEventsForRuntime(events, "sandbox"),
      },
    }),
    [events],
  );
  const runLabel = runStatusLabel(startState, dashboard.run.status, dashboard.run.elapsedLabel);
  const actionLabel = runId ? dashboard.run.actionLabel : "START RUN";

  useEffect(() => {
    if (dashboard.run.status !== "running" && startState !== "running") return;

    setNowIso(new Date().toISOString());
    const timer = setInterval(() => {
      setNowIso(new Date().toISOString());
    }, 1000);

    return () => clearInterval(timer);
  }, [dashboard.run.status, startState]);

  async function startRun() {
    setStartState("starting");
    setError(null);
    setNowIso(new Date().toISOString());

    try {
      const response = await fetch("/api/runs", { method: "POST" });

      if (!response.ok) {
        throw new Error(`Run request failed with ${response.status}`);
      }

      const session = (await response.json()) as RunSessionResponse;
      setRunId(session.runId);
      setEvents(session.events);
      setStartState("running");
    } catch (cause) {
      setStartState("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#0E1013] text-[#E6E8EA]">
      <TopBar
        actionLabel={actionLabel}
        disabled={startState === "starting"}
        error={error}
        onStart={startRun}
        runId={runId}
        runLabel={runLabel}
      />

      <section
        className="grid min-h-[calc(100vh-67px)] lg:grid-cols-2"
        aria-label="Runtime comparison"
      >
        <RuntimeWing
          lanes={lanesByRuntime.workspace}
          runtime="workspace"
          telemetry={dashboard.runtimes.workspace}
        />
        <RuntimeWing
          lanes={lanesByRuntime.sandbox}
          runtime="sandbox"
          telemetry={dashboard.runtimes.sandbox}
        />
      </section>
    </main>
  );
}

function TopBar({
  actionLabel,
  disabled,
  error,
  onStart,
  runId,
  runLabel,
}: {
  actionLabel: string;
  disabled: boolean;
  error: string | null;
  onStart: () => void;
  runId: string | null;
  runLabel: string;
}) {
  return (
    <header className="flex min-h-[67px] flex-wrap items-center justify-between gap-4 border-[#22272E] border-b bg-[#0E1013] px-8 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-8">
        <div className="flex shrink-0 items-center gap-3 border-[#22272E] border-r pr-8">
          <span className="grid size-5 place-items-center rounded-[0.35rem] border-2 border-[#F2A93B] text-[#F2A93B]">
            <span className="size-2 rounded-[0.15rem] bg-[#F2A93B]" />
          </span>
          <span className="font-mono text-sm font-semibold tracking-[0.22em] text-[#E6E8EA] uppercase">
            THINK · RUNTIME COMPARE
          </span>
        </div>

        <div className="min-w-[18rem] flex-1">
          <p className="font-mono text-[0.68rem] tracking-[0.2em] text-[#8A9099] uppercase">
            TASK <span className="tracking-[0.12em]">{fixtureMeta()}</span>
          </p>
          <p className="mt-1 truncate text-sm text-[#E6E8EA]">{comparisonFixture.task}</p>
          {error ? <p className="mt-1 text-xs text-[#E15B5B]">{error}</p> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-5">
        <StatusReadout label={runLabel} />
        {runId ? (
          <code className="font-mono text-xs text-[#8A9099]">{runId}</code>
        ) : (
          <span className="font-mono text-xs text-[#8A9099]">ready</span>
        )}
        <Button
          className="h-[38px] rounded-[0.18rem] border border-[#F2A93B] bg-[#F2A93B] px-7 font-mono text-xs font-semibold tracking-[0.24em] !text-[#0E1013] uppercase hover:bg-[#ffc46d] disabled:border-[#3A4048] disabled:bg-[#171A1F] disabled:!text-[#8A9099]"
          disabled={disabled}
          onClick={onStart}
          type="button"
          variant="primary"
        >
          {disabled ? "STARTING" : actionLabel}
        </Button>
      </div>
    </header>
  );
}

function RuntimeWing({
  lanes,
  runtime,
  telemetry,
}: {
  lanes: { agent: RunEvent[]; runtime: RunEvent[] };
  runtime: RuntimeId;
  telemetry: RuntimeDashboardModel;
}) {
  const copy = runtimeCopy[runtime];
  const mode = wingMode(runtime, telemetry);
  const activityEvents = [...lanes.agent, ...lanes.runtime].sort(
    (left, right) => left.sequence - right.sequence,
  );

  return (
    <article
      aria-label={`${titleCase(runtime)} runtime wing`}
      className="flex max-h-[calc(100vh-67px)] min-w-0 flex-col overflow-hidden border-[#22272E] border-b lg:border-r lg:last:border-r-0"
    >
      <header className="flex min-h-[117px] items-center justify-between gap-6 px-7 py-5">
        <div className="min-w-0">
          <p className={`font-mono text-xs tracking-[0.28em] uppercase ${copy.accent}`}>
            {copy.side} · {copy.label}{" "}
            <span className="tracking-normal text-[#8A9099] normal-case">{copy.packageName}</span>
          </p>
          <h2 className="mt-2 text-[1.75rem] leading-tight font-semibold tracking-[-0.05em] text-[#E6E8EA]">
            {copy.title}
          </h2>
          <p className="mt-2 text-sm text-[#8A9099]">{copy.subtitle}</p>
        </div>
        <StatusPill status={telemetry.status} />
      </header>

      <TelemetryStrip telemetry={telemetry} />

      {capacityHint(telemetry.error) ? (
        <div className="mx-7 mt-5 rounded-sm border border-[#E15B5B]/45 bg-[#E15B5B]/10 p-3 text-sm text-[#E15B5B]">
          {capacityHint(telemetry.error)}
        </div>
      ) : null}

      {mode === "idle" ? <IdlePanel runtime={runtime} /> : null}
      {mode === "boot" ? <BootPanel /> : null}
      {mode === "activity" ? (
        <ActivityPanel events={activityEvents} runtime={runtime} telemetry={telemetry} />
      ) : null}
    </article>
  );
}

function TelemetryStrip({ telemetry }: { telemetry: RuntimeDashboardModel }) {
  const cells =
    telemetry.id === "workspace" ? workspaceTelemetry(telemetry) : sandboxTelemetry(telemetry);

  return (
    <dl className="grid grid-cols-4 border-[#22272E] border-y bg-[#131619] px-7 py-4">
      {cells.map(([label, value], index) => (
        <div
          className={index === cells.length - 1 ? "pl-4" : "border-[#22272E] border-r pr-4"}
          key={label}
        >
          <dt className="font-mono text-[0.68rem] tracking-[0.18em] text-[#8A9099] uppercase">
            {label}
          </dt>
          <dd
            className={`mt-2 font-mono text-2xl font-semibold tracking-[-0.04em] ${label === "Container" ? containerTone[telemetry.container] : "text-[#E6E8EA]"}`}
          >
            {label === "Container" ? (
              <span className="mr-2 text-base text-[#3A4048]">●</span>
            ) : null}
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function workspaceTelemetry(telemetry: RuntimeDashboardModel): Array<[string, string]> {
  const idle = telemetry.status === "idle";
  return [
    ["Files", idle ? "—" : String(telemetry.fileOps)],
    ["Shell", idle ? "—" : String(telemetry.workerShellExecs)],
    ["Container", telemetry.container],
    ["Check", validationLabel(telemetry.validationStatus)],
  ];
}

function sandboxTelemetry(telemetry: RuntimeDashboardModel): Array<[string, string]> {
  const idle = telemetry.status === "idle";
  return [
    ["Files", idle ? "—" : String(telemetry.fileOps)],
    ["Container", idle ? "—" : String(telemetry.containerExecs)],
    ["Check", validationLabel(telemetry.validationStatus)],
    ["Elapsed", telemetry.elapsedLabel === "--:--" ? "—" : telemetry.elapsedLabel],
  ];
}

function validationLabel(status: RuntimeDashboardModel["validationStatus"]): string {
  if (status === "not-run") return "—";
  return status;
}

function IdlePanel({ runtime }: { runtime: RuntimeId }) {
  if (runtime === "workspace") {
    return (
      <section className="grid gap-4 px-7 py-5">
        <PanelHeader
          left="SEED · /workspace/repo"
          right="◇ planned · seeds into DOFS on run start"
          tone="text-[#8A9099]"
        />
        <CodeBlock>{fixtureTree()}</CodeBlock>
        <p className="text-sm text-[#8A9099]">
          On run start, this fixture is written to durable workspace storage before the agent's
          first tool call. Reads, writes, and edits then run with no container in the loop.
        </p>
      </section>
    );
  }

  return (
    <section className="grid gap-4 px-7 py-5">
      <PanelHeader left="SEED · /workspace/repo" right="○ waiting · seeds on container boot" />
      <CodeBlock>{bootPlan(false)}</CodeBlock>
      <p className="text-sm text-[#8A9099]">
        No filesystem exists yet. The container boots when the run starts, then receives the same
        seed before the agent's first tool call.
      </p>
    </section>
  );
}

function BootPanel() {
  return (
    <section className="grid gap-4 px-7 py-5">
      <PanelHeader left="BOOT · /workspace/repo" right="+1.7s · ETA ~0.4s" tone="text-[#8A9099]" />
      <CodeBlock>{bootPlan(true)}</CodeBlock>
      <div className="grid gap-2">
        <div className="flex justify-between font-mono text-[0.68rem] text-[#8A9099]">
          <span>container readiness</span>
          <span>82%</span>
        </div>
        <div className="h-1 bg-[#171A1F]">
          <div className="h-1 w-[82%] bg-[#5BC8A7]" />
        </div>
      </div>
      <p className="text-sm text-[#8A9099]">
        Agent is blocked on container readiness. No tool calls can run until the sandbox finishes
        seeding.
      </p>
    </section>
  );
}

function ActivityPanel({
  events,
  runtime,
  telemetry,
}: {
  events: RunEvent[];
  runtime: RuntimeId;
  telemetry: RuntimeDashboardModel;
}) {
  const copy = runtimeCopy[runtime];
  const headerRight =
    telemetry.status === "completed"
      ? "finished cleanly"
      : `turn ${Math.max(1, events.length)} of —`;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 px-7 py-5">
      <PanelHeader
        left={`ACTIVITY · ${telemetry.status === "completed" ? `${events.length} EVENTS · ${telemetry.toolCalls} TOOL CALLS` : "AGENT TRANSCRIPT"}`}
        right={headerRight}
        tone={telemetry.status === "completed" ? "text-[#5BC8A7]" : "text-[#8A9099]"}
      />
      <AutoScrollList
        ariaLabel={`${titleCase(runtime)} activity stream`}
        className="grid min-h-0 flex-1 gap-3 overflow-y-auto pr-2"
        watchKey={lastEventSequence(events)}
      >
        {events.length === 0 ? (
          <li className="text-sm text-[#8A9099]">Awaiting agent activity.</li>
        ) : (
          events.map((event, index) => (
            <ActivityItem accent={copy.accent} event={event} index={index + 1} key={event.id} />
          ))
        )}
      </AutoScrollList>
    </section>
  );
}

function ActivityItem({
  accent,
  event,
  index,
}: {
  accent: string;
  event: RunEvent;
  index: number;
}) {
  const formatted = formatEventDetail(event.detail);

  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
      <div className="relative font-mono text-xs text-[#F2A93B]">
        {String(index).padStart(2, "0")}
        <span className="absolute top-6 left-3 h-[calc(100%-0.5rem)] w-px bg-[#22272E]" />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
          <span className={`font-semibold ${accent}`}>{eventLabel(event)}</span>
          <span className="text-[#8A9099]">{event.kind.replaceAll("_", " · ")}</span>
          <span className="text-[#5BC8A7]">→ ok</span>
        </div>
        <p className="mt-2 text-sm leading-6 text-[#E6E8EA]">{event.title}</p>
        {formatted.fields.length > 0 ? (
          <dl className="mt-2 grid gap-1 rounded-sm border border-[#22272E] bg-[#171A1F] px-3 py-2 font-mono text-sm">
            {formatted.fields.map((field) => (
              <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3" key={field.label}>
                <dt className="text-[#8A9099]">{field.label}</dt>
                <dd className="overflow-x-auto whitespace-pre-wrap text-[#E6E8EA]">
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <MarkdownText text={formatted.text ?? ""} />
        )}
      </div>
    </li>
  );
}

function PanelHeader({
  left,
  right,
  tone = "text-[#8A9099]",
}: {
  left: string;
  right: string;
  tone?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 font-mono text-[0.68rem] tracking-[0.2em] uppercase">
      <span className="text-[#8A9099]">{left}</span>
      <span className={tone}>{right}</span>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-sm border border-[#22272E] bg-[#171A1F] px-4 py-4 font-mono text-sm leading-7 text-[#C9CDD2]">
      {children}
    </pre>
  );
}

function StatusPill({ status }: { status: RuntimeDashboardModel["status"] }) {
  const label = status === "completed" ? "done" : status;
  return (
    <span
      className={`border px-3 py-2 font-mono text-[0.68rem] tracking-[0.18em] uppercase ${statusTone[status]}`}
    >
      ● {label}
    </span>
  );
}

function StatusReadout({ label }: { label: string }) {
  const done = label.startsWith("DONE");
  const run = label.startsWith("RUN");
  const tone = done ? "text-[#5BC8A7]" : run ? "text-[#F2A93B]" : "text-[#8A9099]";

  return (
    <span className="border border-[#22272E] bg-[#171A1F] px-4 py-2 font-mono text-xs tracking-[0.18em] uppercase">
      <span className={tone}>●</span> {label}
    </span>
  );
}

function wingMode(runtime: RuntimeId, telemetry: RuntimeDashboardModel): WingMode {
  if (telemetry.status === "idle") return "idle";
  if (runtime === "sandbox" && telemetry.container === "booting") return "boot";
  return "activity";
}

function runStatusLabel(startState: StartState, status: string, elapsedLabel: string): string {
  if (startState === "starting") return "STARTING";
  if (startState === "failed" || status === "failed") return `FAILED · ${elapsedLabel}`;
  if (status === "completed") return `DONE · ${elapsedLabel}`;
  if (status === "running") return `RUN · ${elapsedLabel}`;
  return "IDLE";
}

function fixtureMeta(): string {
  return `${comparisonFixture.files.length} files`;
}

function fixtureTree(): string {
  const srcFiles = comparisonFixture.files
    .filter((file) => file.path.startsWith("src/"))
    .map((file) => `  ${file.path.slice(4)}`);
  const testFiles = comparisonFixture.files
    .filter((file) => file.path.includes("test"))
    .map((file) => `  ${file.path.replace(/^src\//, "")}`);
  const rootFiles = comparisonFixture.files
    .filter((file) => !file.path.startsWith("src/") && !file.path.includes("test"))
    .map((file) => file.path);

  return [`▾ src/`, ...srcFiles, `▾ test/`, ...testFiles, ...rootFiles].join("\n");
}

function bootPlan(active: boolean): string {
  if (active) {
    return [
      "✓  pull image · cloudflare/sandbox:0.11.0        cached · 0.0s",
      "✓  cold-start container                         1.4s",
      "▸  writing files into /workspace/repo           5 of 7",
      "○  await tool calls from agent                  —",
    ].join("\n");
  }

  return [
    "01  pull image · cloudflare/sandbox:0.11.0        ~ cached",
    "02  cold-start container                         ~ 1.5s",
    "03  write files into /workspace/repo              ~ seed bytes",
    "04  await tool calls from agent                  —",
  ].join("\n");
}

function eventLabel(event: RunEvent): string {
  if (event.kind === "agent_message") return "assistant";
  if (event.kind.includes("tool"))
    return event.title.toLowerCase().includes("exec") ? "tool · exec" : "tool";
  if (event.kind.includes("runtime")) return "runtime";
  return "event";
}

function capacityHint(error: string | null): string | null {
  if (!error) return null;
  return error.includes("Capacity temporarily exceeded")
    ? "Upstream model capacity; retry later."
    : null;
}

function lastEventSequence(events: RunEvent[]): number {
  return events.at(-1)?.sequence ?? 0;
}

function titleCase(value: RuntimeId): string {
  return value === "workspace" ? "Workspace" : "Sandbox";
}
