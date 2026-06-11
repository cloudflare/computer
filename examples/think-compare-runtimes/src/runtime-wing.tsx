import type { RunEvent, RuntimeId } from "../shared/events";
import { comparisonFixture } from "../shared/fixture";
import { AutoScrollList } from "./auto-scroll-list";
import type { ContainerState, RuntimeDashboardModel } from "./dashboard-model";
import { MarkdownText } from "./markdown-text";
import { detailFieldsForEvent } from "./run-event-facts";
import { buildRuntimePanelModel, type RuntimeEvidenceGroup } from "./runtime-panel-model";

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
  },
  sandbox: {
    side: "R",
    label: "SANDBOX",
    packageName: "@cloudflare/sandbox",
    title: "Container filesystem",
    subtitle: "Same fixture is seeded into the Sandbox filesystem. File tools and exec run there.",
    accent: "text-[#5BC8A7]",
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

export function RuntimeWing({
  events,
  runtime,
  telemetry,
}: {
  events: RunEvent[];
  runtime: RuntimeId;
  telemetry: RuntimeDashboardModel;
}) {
  const copy = runtimeCopy[runtime];
  const mode = wingMode(runtime, telemetry);
  const panel = buildRuntimePanelModel(events, runtime, telemetry);

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
        <ActivityPanel panel={panel} runtime={runtime} telemetry={telemetry} />
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
  panel,
  runtime,
  telemetry,
}: {
  panel: ReturnType<typeof buildRuntimePanelModel>;
  runtime: RuntimeId;
  telemetry: RuntimeDashboardModel;
}) {
  const groups = panel.evidenceGroups;
  const headerRight =
    telemetry.status === "completed"
      ? "finished cleanly"
      : `${groups.length} groups · ${telemetry.toolCalls} tool calls`;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 px-7 py-5">
      <PanelHeader
        left="ACTIVITY · ROUTING + EVIDENCE"
        right={headerRight}
        tone={telemetry.status === "completed" ? "text-[#5BC8A7]" : "text-[#8A9099]"}
      />
      <AutoScrollList
        ariaLabel={`${titleCase(runtime)} activity stream`}
        className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto pr-2"
        watchKey={lastEventSequence(telemetry.events)}
      >
        <li>
          <RoutingSummary rows={panel.routingRows} />
        </li>
        {groups.length === 0 ? (
          <li className="text-sm text-[#8A9099]">Awaiting agent activity.</li>
        ) : (
          groups.map((group, index) => (
            <EvidenceItem group={group} index={index + 1} key={group.id} runtime={runtime} />
          ))
        )}
      </AutoScrollList>
    </section>
  );
}

function RoutingSummary({
  rows,
}: {
  rows: ReturnType<typeof buildRuntimePanelModel>["routingRows"];
}) {
  return (
    <section className="rounded-sm border border-[#22272E] bg-[#101317] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-mono text-[0.68rem] tracking-[0.2em] text-[#8A9099] uppercase">
          Routing summary
        </h3>
        <span className="font-mono text-[0.68rem] text-[#3A4048]">live from events</span>
      </div>
      <dl className="mt-3 grid gap-2 text-sm">
        {rows.map(({ label, value }) => (
          <div className="grid grid-cols-[132px_minmax(0,1fr)] gap-3" key={label}>
            <dt className="font-mono text-[#8A9099]">{label}</dt>
            <dd className="text-[#E6E8EA]">
              {label} → {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function EvidenceItem({
  group,
  index,
  runtime,
}: {
  group: RuntimeEvidenceGroup;
  index: number;
  runtime: RuntimeId;
}) {
  const copy = runtimeCopy[runtime];
  const tone = evidenceTone(group.tone, copy.accent);
  const finalMessage = group.events.find((event) => event.kind === "agent_message");

  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
      <div className={`relative font-mono text-xs ${tone.marker}`}>
        {String(index).padStart(2, "0")}
        <span className="absolute top-6 left-3 h-[calc(100%-0.5rem)] w-px bg-[#22272E]" />
      </div>
      <article className={`min-w-0 rounded-sm border px-4 py-3 ${tone.card}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3
            className={`font-mono text-xs font-semibold tracking-[0.12em] uppercase ${tone.title}`}
          >
            {group.title}
          </h3>
          <span className="font-mono text-[0.68rem] text-[#8A9099]">
            {group.events.length} event{group.events.length === 1 ? "" : "s"}
          </span>
        </div>
        <p className="mt-2 text-sm leading-6 text-[#E6E8EA]">{group.summary}</p>
        {finalMessage ? <MarkdownText text={finalMessage.detail} /> : null}
        {group.events.length > 0 && !finalMessage ? (
          <details className="mt-3 border-[#22272E] border-t pt-3">
            <summary className="cursor-pointer font-mono text-[0.68rem] tracking-[0.16em] text-[#8A9099] uppercase">
              Raw events
            </summary>
            <ol className="mt-3 grid gap-3">
              {group.events.map((event) => (
                <RawEvent event={event} key={event.id} />
              ))}
            </ol>
          </details>
        ) : null}
      </article>
    </li>
  );
}

function RawEvent({ event }: { event: RunEvent }) {
  const fields = detailFieldsForEvent(event);

  return (
    <li className="rounded-sm border border-[#22272E] bg-[#171A1F] px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        <span className="text-[#8A9099]">{event.kind.replaceAll("_", " · ")}</span>
        <span className="text-[#3A4048]">#{event.sequence}</span>
      </div>
      <p className="mt-2 text-sm text-[#C9CDD2]">{event.title}</p>
      {fields.length > 0 ? (
        <dl className="mt-2 grid gap-1 font-mono text-xs">
          {fields.map((field) => (
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3" key={field.label}>
              <dt className="text-[#8A9099]">{field.label}</dt>
              <dd className="overflow-x-auto whitespace-pre-wrap text-[#E6E8EA]">{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-sm text-[#C9CDD2]">{event.detail}</p>
      )}
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

function wingMode(runtime: RuntimeId, telemetry: RuntimeDashboardModel): WingMode {
  if (telemetry.status === "idle") return "idle";
  if (runtime === "sandbox" && telemetry.container === "booting") return "boot";
  return "activity";
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

function evidenceTone(tone: RuntimeEvidenceGroup["tone"], accent: string) {
  if (tone === "success") {
    return {
      marker: "text-[#5BC8A7]",
      title: "text-[#5BC8A7]",
      card: "border-[#5BC8A7]/35 bg-[#5BC8A7]/5",
    };
  }
  if (tone === "error") {
    return {
      marker: "text-[#E15B5B]",
      title: "text-[#E15B5B]",
      card: "border-[#E15B5B]/45 bg-[#E15B5B]/10",
    };
  }
  return {
    marker: accent,
    title: accent,
    card: "border-[#22272E] bg-[#101317]",
  };
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
