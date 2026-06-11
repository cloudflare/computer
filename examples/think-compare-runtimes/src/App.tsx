import { usePartySocket } from "partysocket/react";
import { useEffect, useMemo, useState } from "react";
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
