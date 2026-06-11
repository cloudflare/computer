import { usePartySocket } from "partysocket/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RunEvent } from "../shared/events";
import { buildDashboardModel } from "./dashboard-model";
import { applyRunMessage, type RunMessage } from "./run-state";
import { RuntimeWing } from "./runtime-wing";
import { TopBar } from "./top-bar";

interface RunSessionResponse {
  runId: string;
  socketPath: string;
  events: RunEvent[];
}

type StartState = "idle" | "starting" | "running" | "failed";

export function App() {
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [startState, setStartState] = useState<StartState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [nowIso, setNowIso] = useState(() => new Date().toISOString());
  const activeRunIdRef = useRef<string | null>(null);

  usePartySocket({
    party: "compare-run",
    room: runId ?? "idle",
    enabled: runId !== null,
    onMessage(message) {
      const parsed = JSON.parse(String(message.data)) as RunMessage;
      const activeRunId = activeRunIdRef.current;
      if (!activeRunId || !messageBelongsToRun(parsed, activeRunId)) return;
      setEvents((current) => applyRunMessage(current, parsed));
    },
  });

  const dashboard = useMemo(() => buildDashboardModel(events, nowIso), [events, nowIso]);
  const runLabel = runStatusLabel(startState, dashboard.run.status, dashboard.run.elapsedLabel);
  const actionLabel =
    startState === "starting"
      ? "STARTING"
      : startState === "running" && dashboard.run.status === "running"
        ? "STOP RUN"
        : runId
          ? dashboard.run.actionLabel
          : "START RUN";
  const startDisabled = startState === "starting";

  useEffect(() => {
    if (dashboard.run.status !== "running" && startState !== "running") return;

    setNowIso(new Date().toISOString());
    const timer = setInterval(() => {
      setNowIso(new Date().toISOString());
    }, 1000);

    return () => clearInterval(timer);
  }, [dashboard.run.status, startState]);

  async function handleRunAction() {
    if (startState === "running" && dashboard.run.status === "running") {
      stopRun();
      return;
    }
    await startRun();
  }

  async function startRun() {
    activeRunIdRef.current = null;
    setRunId(null);
    setEvents([]);
    setStartState("starting");
    setError(null);
    setNowIso(new Date().toISOString());

    try {
      const response = await fetch("/api/runs", { method: "POST" });

      if (!response.ok) {
        throw new Error(`Run request failed with ${response.status}`);
      }

      const session = (await response.json()) as RunSessionResponse;
      activeRunIdRef.current = session.runId;
      setRunId(session.runId);
      setEvents(session.events);
      setStartState("running");
    } catch (cause) {
      setStartState("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function stopRun() {
    const stoppedRunId = activeRunIdRef.current ?? runId;
    activeRunIdRef.current = null;
    setRunId(null);
    setEvents([]);
    setStartState("idle");
    setError(null);
    setNowIso(new Date().toISOString());

    if (stoppedRunId) {
      void fetch(`/api/runs/${encodeURIComponent(stoppedRunId)}/stop`, { method: "POST" });
    }
  }

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-[#FBFAF6] text-[#111111]">
      <TopBar
        actionLabel={actionLabel}
        disabled={startDisabled}
        error={error}
        onStart={handleRunAction}
        runId={runId}
        runLabel={runLabel}
      />

      <section className="grid min-h-0 flex-1 lg:grid-cols-2" aria-label="Runtime comparison">
        <RuntimeWing events={events} runtime="workspace" telemetry={dashboard.runtimes.workspace} />
        <RuntimeWing events={events} runtime="sandbox" telemetry={dashboard.runtimes.sandbox} />
      </section>
    </main>
  );
}

function runStatusLabel(startState: StartState, status: string, elapsedLabel: string): string {
  if (startState === "starting") return "STARTING";
  if (startState === "failed" || status === "failed") return `FAILED · ${elapsedLabel}`;
  if (status === "completed") return `DONE · ${elapsedLabel}`;
  if (status === "running") return `RUN · ${elapsedLabel}`;
  return "IDLE";
}

function messageBelongsToRun(message: RunMessage, runId: string): boolean {
  if (message.type === "event") return message.event.runId === runId;
  return message.events.every((event) => event.runId === runId);
}
