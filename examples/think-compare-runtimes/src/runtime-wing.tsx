import type { RunEvent, RuntimeId } from "../shared/events";
import { AutoScrollList } from "./auto-scroll-list";
import type { RuntimeDashboardModel } from "./dashboard-model";
import { MarkdownText } from "./markdown-text";
import {
  type AgentWorkItem,
  buildRuntimePanelModel,
  type RuntimePanelModel,
  type SegmentStatus,
  type TimelineLane,
  type TimelineMarker,
  type TimelineSegment,
  type TimelineTone,
} from "./runtime-panel-model";

const runtimeCopy: Record<
  RuntimeId,
  {
    label: "Workspace" | "Sandbox";
    packageName: string;
  }
> = {
  workspace: {
    label: "Workspace",
    packageName: "@cloudflare/computer",
  },
  sandbox: {
    label: "Sandbox",
    packageName: "@cloudflare/sandbox",
  },
};

const statusTone = {
  idle: "text-[#8F8A81]",
  running: "text-[#1D4ED8]",
  completed: "text-[#166534]",
  failed: "text-[#B42318]",
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
  const panel = buildRuntimePanelModel(events, runtime, telemetry);

  return (
    <article
      aria-label={`${copy.label} runtime wing`}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden border-[#DED8CD] border-b bg-[#FBFAF6] lg:border-r lg:last:border-r-0"
    >
      <header className="grid shrink-0 gap-3 px-6 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="font-semibold text-xl tracking-[-0.06em] text-[#111111]">
              {copy.label}
            </h2>
            <span className="font-mono text-[0.68rem] tracking-[0.22em] text-[#8F8A81] uppercase">
              {copy.packageName}
            </span>
          </div>
        </div>
        <span
          className={`border border-[#DED8CD] bg-white px-3 py-2 font-mono text-[0.68rem] tracking-[0.18em] uppercase ${statusTone[telemetry.status]}`}
        >
          ● {panel.statusLine}
        </span>
      </header>

      {capacityHint(telemetry.error) ? (
        <div className="mx-6 shrink-0 border border-[#F4C7C3] bg-[#FFF4F2] p-2 text-sm text-[#B42318]">
          {capacityHint(telemetry.error)}
        </div>
      ) : null}

      <section className="grid min-h-0 flex-1 grid-rows-[auto_auto_minmax(0,1fr)] gap-3 overflow-hidden px-6 pt-3 pb-4">
        <SummaryStrip items={panel.summary} />
        <SubstrateTimeline model={panel} runtime={runtime} />
        <AgentWorkStream model={panel} runtime={runtime} />
      </section>
    </article>
  );
}

function SummaryStrip({ items }: { items: RuntimePanelModel["summary"] }) {
  return (
    <dl
      className="grid border border-[#DED8CD] bg-white"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((item) => (
        <div className="border-[#DED8CD] border-r px-3 py-2 last:border-r-0" key={item.label}>
          <dt className="font-mono text-[0.65rem] tracking-[0.18em] text-[#8F8A81] uppercase">
            {item.label}
          </dt>
          <dd className="mt-1 font-mono text-lg tracking-[-0.05em] text-[#111111]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SubstrateTimeline({ model, runtime }: { model: RuntimePanelModel; runtime: RuntimeId }) {
  const scale = timelineScale(model);
  return (
    <section
      className="shrink-0 border border-[#DED8CD] bg-white px-4 py-4"
      aria-label={`${runtime} substrate timeline`}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3 font-mono text-[0.68rem] tracking-[0.18em] text-[#8F8A81] uppercase">
        <span>Timeline</span>
        <span>{model.clock.durationLabel}</span>
      </div>
      <TimelineLegend />
      <div className="grid gap-5">
        {model.lanes.map((lane) => (
          <TimelineLaneView key={lane.id} lane={lane} scale={scale} />
        ))}
      </div>
      <div className="mt-4 flex justify-between border-[#EEE9E0] border-t pt-2 font-mono text-[0.65rem] text-[#B6B0A6]">
        <span>0:00</span>
        <span>{scale.durationMs > 0 ? formatMs(scale.durationMs) : "waiting"}</span>
      </div>
    </section>
  );
}

function TimelineLaneView({ lane, scale }: { lane: TimelineLane; scale: TimelineScale }) {
  return (
    <div className="grid gap-2 md:grid-cols-[158px_minmax(0,1fr)] md:items-center">
      <div className="flex items-center gap-2 font-mono text-[0.68rem] tracking-[0.14em] text-[#4A453D] uppercase">
        <span className={`h-1.5 w-5 ${toneClass(lane.tone)}`} />
        {lane.label}
      </div>
      <div className="relative h-7 border-[#EEE9E0] border-l bg-[#FBFAF6]">
        {lane.segments.map((segment) => (
          <Segment key={segment.id} scale={scale} segment={segment} tone={lane.tone} />
        ))}
        {lane.markers.map((marker) => (
          <Marker key={marker.id} marker={marker} scale={scale} tone={lane.tone} />
        ))}
        {lane.segments.length === 0 && lane.markers.length === 0 ? (
          <span className="absolute top-1/2 left-3 -translate-y-1/2 font-mono text-[0.65rem] text-[#C7C0B6] uppercase">
            no activity
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Segment({
  scale,
  segment,
  tone,
}: {
  scale: TimelineScale;
  segment: TimelineSegment;
  tone: TimelineTone;
}) {
  const left = positionPct(segment.startMs, scale);
  const width = Math.max(positionPct(segment.endMs, scale) - left, 2.5);
  return (
    <div
      aria-label={`${segment.label} ${formatMs(segment.startMs - scale.startMs)} to ${formatMs(segment.endMs - scale.startMs)}`}
      className={`absolute top-1/2 h-5 -translate-y-1/2 ${segmentClass(segment.status, tone)}`}
      role="img"
      style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
      title={segment.label}
    >
      <span className="sr-only">{segment.label}</span>
    </div>
  );
}

function Marker({
  marker,
  scale,
  tone,
}: {
  marker: TimelineMarker;
  scale: TimelineScale;
  tone: TimelineTone;
}) {
  return (
    <span
      aria-label={marker.label}
      className={`absolute top-1/2 h-5 w-1.5 -translate-y-1/2 ${marker.status === "failed" ? "bg-[#B42318]" : toneClass(tone)}`}
      role="img"
      style={{ left: `${positionPct(marker.atMs, scale)}%` }}
      title={marker.label}
    />
  );
}

function TimelineLegend() {
  return (
    <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[0.62rem] tracking-[0.12em] text-[#8F8A81] uppercase">
      <LegendSwatch className="bg-[#1D4ED8]" label="VFS" />
      <LegendSwatch className="bg-[#7C3AED]" label="dynamic worker" />
      <LegendSwatch className="bg-[#F4C98F] opacity-55" label="container assigned" />
      <LegendSwatch className="bg-[#D97706]" label="command running" />
      <LegendSwatch
        className="bg-[repeating-linear-gradient(45deg,#F4C98F_0,#F4C98F_3px,transparent_3px,transparent_7px)] opacity-55"
        label="sleep tail"
      />
      <LegendSwatch className="bg-[#166534]" label="check passed" />
      <LegendSwatch className="bg-[#B42318]" label="failed" />
    </div>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`h-1.5 w-4 ${className}`} />
      {label}
    </span>
  );
}

function AgentWorkStream({ model, runtime }: { model: RuntimePanelModel; runtime: RuntimeId }) {
  const items = model.workItems;
  return (
    <section className="relative flex min-h-0 flex-col overflow-hidden border-[#DED8CD] border-t pt-3 pb-2">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="font-mono text-[0.68rem] tracking-[0.18em] text-[#8F8A81] uppercase">
          Agent work
        </h3>
        <span className="font-mono text-[0.65rem] tracking-[0.14em] text-[#B6B0A6] uppercase">
          {items.length} activities
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-[#8F8A81]">Waiting for the agent to start.</p>
      ) : (
        <div className="relative min-h-0 flex-1 before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-0 before:z-10 before:h-8 before:bg-gradient-to-b before:from-[#FBFAF6] before:to-transparent">
          <AutoScrollList
            ariaLabel={`${runtime} agent work stream`}
            className="flex h-full min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain pr-2 pt-4 pb-3"
            watchKey={workStreamWatchKey(items)}
          >
            {items.map((item) => (
              <AgentWorkRow item={item} key={item.id} />
            ))}
          </AutoScrollList>
        </div>
      )}
    </section>
  );
}

function AgentWorkRow({ item }: { item: AgentWorkItem }) {
  if (item.presentation === "terminal") {
    return <TerminalWorkRow item={item} />;
  }

  if (item.presentation === "compact") {
    return <CompactWorkRow item={item} />;
  }

  return (
    <li className={`border-l-2 py-2 pl-3 ${workToneClass(item)}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-[0.65rem] tracking-[0.16em] uppercase">{item.label}</span>
      </div>
      <div className={`mt-1 text-sm leading-6 ${markdownToneClass(item)}`}>
        <MarkdownText text={item.text} />
      </div>
    </li>
  );
}

function CompactWorkRow({ item }: { item: AgentWorkItem }) {
  return (
    <li className="flex items-baseline gap-3 py-1 text-sm leading-5">
      <span
        className={`font-mono text-[0.65rem] tracking-[0.16em] uppercase ${compactToneClass(item)}`}
      >
        {item.label}
      </span>
      <span className="min-w-0 flex-1 truncate text-[#4A453D]">{item.text}</span>
    </li>
  );
}

function TerminalWorkRow({ item }: { item: AgentWorkItem }) {
  return (
    <li className="py-1.5 text-sm leading-5">
      <div className="flex flex-wrap items-baseline gap-2 font-mono text-[0.62rem] tracking-[0.14em] uppercase">
        <span className={compactToneClass(item)}>{item.label}</span>
        {item.executionTarget ? (
          <span className="text-[#8F8A81]">{executionTargetCopy(item.executionTarget)}</span>
        ) : null}
        {typeof item.exitCode === "number" ? (
          <span className={item.exitCode === 0 ? "text-[#166534]" : "text-[#B42318]"}>
            exit {item.exitCode}
          </span>
        ) : null}
      </div>
      <code className="mt-1 block truncate font-mono text-[0.78rem] text-[#24211D]">
        $ {item.command ?? item.text}
      </code>
      {item.stdout || item.stderr ? <CommandOutput item={item} /> : null}
    </li>
  );
}

function CommandOutput({ item }: { item: AgentWorkItem }) {
  const output = [
    item.stdout ? `stdout\n${item.stdout}` : null,
    item.stderr ? `stderr\n${item.stderr}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  return (
    <details className="mt-1 text-[#4A453D]">
      <summary className="cursor-pointer font-mono text-[0.62rem] tracking-[0.14em] text-[#8F8A81] uppercase">
        output
      </summary>
      <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap border-[#EEE9E0] border-l pl-3 font-mono text-[0.72rem] leading-5">
        {output.length > 1200 ? `${output.slice(0, 1200)}\n…` : output}
      </pre>
    </details>
  );
}

function workStreamWatchKey(items: AgentWorkItem[]): string {
  const textLength = items.reduce(
    (total, item) =>
      total + item.text.length + (item.stdout?.length ?? 0) + (item.stderr?.length ?? 0),
    0,
  );
  return `${items.length}:${textLength}`;
}

function workToneClass(item: AgentWorkItem): string {
  if (item.tone === "error") return "border-[#B42318] text-[#B42318]";
  if (item.kind === "thinking") return "border-[#DED8CD] text-[#8F8A81]";
  if (item.tone === "success") return "border-[#166534] text-[#166534]";
  return "border-[#1D4ED8] text-[#1D4ED8]";
}

function markdownToneClass(item: AgentWorkItem): string {
  if (item.tone === "error") return "text-[#B42318]";
  if (item.kind === "thinking") return "text-[#6F6A62] opacity-75";
  return "text-[#24211D]";
}

function compactToneClass(item: AgentWorkItem): string {
  if (item.tone === "error") return "text-[#B42318]";
  if (item.tone === "success") return "text-[#166534]";
  if (item.kind === "exec") return "text-[#9A5B00]";
  return "text-[#8F8A81]";
}

function executionTargetCopy(target: NonNullable<AgentWorkItem["executionTarget"]>): string {
  if (target === "worker-shell") return "dynamic worker";
  if (target === "computer-container") return "workspace container";
  return "sandbox container";
}

interface TimelineScale {
  startMs: number;
  endMs: number;
  durationMs: number;
}

function timelineScale(model: RuntimePanelModel): TimelineScale {
  const startMs = model.clock.startMs ?? model.clock.endMs ?? 0;
  const segmentEndMs = model.lanes.flatMap((lane) => lane.segments.map((segment) => segment.endMs));
  const markerMs = model.lanes.flatMap((lane) => lane.markers.map((marker) => marker.atMs));
  const endMs = Math.max(model.clock.endMs ?? startMs, startMs, ...segmentEndMs, ...markerMs);
  return { startMs, endMs, durationMs: endMs - startMs };
}

function positionPct(timestamp: number, scale: TimelineScale): number {
  if (scale.durationMs <= 0) return 0;
  return Math.max(0, Math.min(100, ((timestamp - scale.startMs) / scale.durationMs) * 100));
}

function formatMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function toneClass(tone: TimelineTone): string {
  if (tone === "container") return "bg-[#D97706]";
  if (tone === "dynamic-worker") return "bg-[#7C3AED]";
  if (tone === "error") return "bg-[#B42318]";
  if (tone === "agent") return "bg-[#111111]";
  return "bg-[#1D4ED8]";
}

function segmentClass(status: SegmentStatus, tone: TimelineTone): string {
  if (status === "failed") return "bg-[#B42318]";
  if (status === "passed") return "bg-[#166534]";
  if (status === "lease") return "bg-[#F4C98F] opacity-55";
  if (status === "residual") {
    return "bg-[repeating-linear-gradient(45deg,#F4C98F_0,#F4C98F_3px,transparent_3px,transparent_7px)] opacity-55";
  }
  return toneClass(tone);
}

function capacityHint(error: string | null): string | null {
  if (!error) return null;
  return error.includes("Capacity temporarily exceeded")
    ? "Upstream model capacity; retry later."
    : null;
}
