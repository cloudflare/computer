import { useAgentChat } from "@cloudflare/ai-chat/react";
import {
  ArrowUp,
  BracketsCurly,
  CheckCircle,
  CircleNotch,
  Code,
  Database,
  GitBranch,
  LockKey,
  Plus,
  Stop,
  Warning,
} from "@phosphor-icons/react";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  BenchmarkAgentState,
  BenchmarkLane,
  BenchmarkRequest,
  OolongSampleMetadata,
  RunStatus,
} from "../shared/types";
import { COMPARISON_LANES, lanesToLaunch } from "./experiment-control";

const SESSION_KEY = "computer-rlm-session";
const SAMPLE_KEY = "computer-rlm-sample";
type Sample = BenchmarkRequest["benchmark"]["sample"];

const SAMPLES: Array<{ id: Sample; label: string; detail: string }> = [
  {
    id: "synth-frequency",
    label: "Classify 2,433 records",
    detail: "Model map/reduce · 307 KB",
  },
  { id: "rolls", label: "Count every roll", detail: "Exact aggregation · row 0" },
  { id: "spell-order", label: "First spell per character", detail: "Ordered extraction · row 30" },
  { id: "rare-spells", label: "Least common spells", detail: "Exhaustive classification · row 35" },
  { id: "upcast-spells", label: "Upcast spell detection", detail: "Semantic extraction · row 39" },
  {
    id: "long-spell-sequence",
    label: "Last spell across episodes",
    detail: "1 MB multi-document · row 2500",
  },
];

const EMPTY = (lane: BenchmarkLane): BenchmarkAgentState => ({
  id: lane,
  lane,
  status: "idle",
  prompt: "",
  finalAnswer: "",
  error: null,
  startedAt: null,
  finishedAt: null,
  run: null,
  children: [],
});

export function App() {
  const local = isLocalHost();
  const [access, setAccess] = useState<"checking" | "locked" | "ready">(
    local ? "ready" : "checking",
  );
  const [sessionId] = useState(getOrCreateSessionId);

  useEffect(() => {
    if (local) return;
    const controller = new AbortController();
    void fetch("/api/session", { credentials: "same-origin", signal: controller.signal })
      .then((response) => setAccess(response.ok ? "ready" : "locked"))
      .catch(() => setAccess("locked"));
    return () => controller.abort();
  }, [local]);

  if (access !== "ready") {
    return (
      <AccessGate
        checking={access === "checking"}
        onUnlock={async (token) => {
          const response = await fetch("/api/session", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
            return typeof body?.error === "string"
              ? body.error
              : "The demo token was not accepted.";
          }
          setAccess("ready");
          return null;
        }}
      />
    );
  }
  return <Experiment sessionId={sessionId} />;
}

function Experiment({ sessionId }: { sessionId: string }) {
  const [sample, setSample] = useState<Sample>(getStoredSample);
  const [runId, setRunId] = useState(() => crypto.randomUUID());
  const [order, setOrder] = useState<BenchmarkLane[] | null>(null);
  const [startedLanes, setStartedLanes] = useState<Set<BenchmarkLane>>(() => new Set());
  const [cancelling, setCancelling] = useState(false);
  const [stoppedLanes, setStoppedLanes] = useState<Set<BenchmarkLane>>(() => new Set());
  const [orchestrationError, setOrchestrationError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const directAgent = useAgent<BenchmarkAgentState>({
    agent: "direct-agent",
    name: `${sessionId}-direct`,
  });
  const executorAgent = useAgent<BenchmarkAgentState>({
    agent: "executor-agent",
    name: `${sessionId}-executor`,
  });
  const rlmAgent = useAgent<BenchmarkAgentState>({ agent: "rlm-agent", name: `${sessionId}-rlm` });
  const direct = directAgent.state ?? EMPTY("direct");
  const executor = executorAgent.state ?? EMPTY("executor");
  const rlm = rlmAgent.state ?? EMPTY("rlm");
  const states = { direct, executor, rlm };

  const bodyFor = useCallback(
    (lane: BenchmarkLane): Record<string, unknown> => ({
      benchmark: {
        taskId: sample === "synth-frequency" ? "oolong-synth-v1" : "oolong-real-dnd-v1",
        sample,
        runId,
        order: order?.indexOf(lane) ?? undefined,
      },
    }),
    [order, runId, sample],
  );
  const directBody = useMemo(() => bodyFor("direct"), [bodyFor]);
  const executorBody = useMemo(() => bodyFor("executor"), [bodyFor]);
  const rlmBody = useMemo(() => bodyFor("rlm"), [bodyFor]);
  const directChat = useAgentChat({ agent: directAgent, body: directBody, throttle: 50 });
  const executorChat = useAgentChat({ agent: executorAgent, body: executorBody, throttle: 50 });
  const rlmChat = useAgentChat({ agent: rlmAgent, body: rlmBody, throttle: 50 });
  const sendDirect = directChat.sendMessage;
  const sendExecutor = executorChat.sendMessage;
  const sendRlm = rlmChat.sendMessage;
  const launch = useCallback(
    (lane: BenchmarkLane) => {
      const message = { text: `Run official Oolong sample ${sample} with the ${lane} strategy.` };
      if (lane === "direct") return sendDirect(message);
      if (lane === "executor") return sendExecutor(message);
      return sendRlm(message);
    },
    [sample, sendDirect, sendExecutor, sendRlm],
  );

  const rlmMapStarted =
    rlm.children.length > 0 ||
    stoppedLanes.has("rlm") ||
    (rlm.run?.runId === runId && isTerminal(rlm.status));

  useEffect(() => {
    if (!order) return;
    const lanes = lanesToLaunch(startedLanes, cancelled.current, rlmMapStarted);
    if (lanes.length === 0) return;
    setStartedLanes((current) => new Set([...current, ...lanes]));
    void Promise.all([directAgent.ready, executorAgent.ready, rlmAgent.ready])
      .then(() => {
        if (cancelled.current) return;
        const launches = lanes.map(async (lane) => launch(lane));
        void Promise.allSettled(launches);
      })
      .catch(() => {
        cancelled.current = true;
        void Promise.allSettled([directChat.stop(), executorChat.stop(), rlmChat.stop()]);
        setOrder(null);
        setStartedLanes(new Set());
        setOrchestrationError(
          "The comparison could not connect to its workers. Start a new session and retry.",
        );
      });
  }, [
    directAgent.ready,
    directChat,
    executorAgent.ready,
    executorChat,
    launch,
    order,
    rlmAgent.ready,
    rlmChat,
    rlmMapStarted,
    startedLanes,
  ]);

  const finished =
    order?.filter(
      (lane) =>
        stoppedLanes.has(lane) ||
        (states[lane].run?.runId === runId && isTerminal(states[lane].status)),
    ).length ?? 0;
  const completed = finished === order?.length;
  const active = order !== null && !completed;
  const baselinesStarted = startedLanes.has("direct") && startedLanes.has("executor");
  const runNotice = active
    ? baselinesStarted
      ? "All three strategies are overlapping now"
      : "RLM is authoring its program · baselines start with the first map call"
    : "Overlapping strategies · can take several minutes · Workers AI charges may apply";
  const hashes = [
    direct.run?.sample.contextHash,
    executor.run?.sample.contextHash,
    rlm.run?.sample.contextHash,
  ].filter(Boolean);
  const identical = hashes.length === 3 && new Set(hashes).size === 1;

  function run() {
    if (active || cancelling) return;
    cancelled.current = false;
    setOrchestrationError(null);
    setRunId(crypto.randomUUID());
    setStoppedLanes(new Set());
    setOrder([...COMPARISON_LANES]);
    setStartedLanes(new Set());
  }

  async function cancelExperiment() {
    if (!active || cancelling) return;
    cancelled.current = true;
    setCancelling(true);
    try {
      await Promise.allSettled([directChat.stop(), executorChat.stop(), rlmChat.stop()]);
    } finally {
      setOrder(null);
      setStartedLanes(new Set());
      setCancelling(false);
    }
  }

  function stopLane(lane: BenchmarkLane, stop: () => void | Promise<void>) {
    setStoppedLanes((current) => new Set([...current, lane]));
    void stop();
  }

  function reset() {
    localStorage.setItem(SESSION_KEY, crypto.randomUUID());
    window.location.reload();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span>
            <BracketsCurly weight="bold" />
          </span>
          <div>
            <strong>RLM with Computer</strong>
            <small>Models for meaning · code for totals</small>
          </div>
        </div>
        <div className="topline">
          <span>Context is data, not a prompt</span>
          {hashes.length ? (
            <b className={identical ? "good" : "bad"}>
              {identical ? <CheckCircle weight="fill" /> : <Warning weight="fill" />}
              {identical ? "Identical corpus" : "Hash mismatch"}
            </b>
          ) : null}
        </div>
        <button className="new-run" type="button" onClick={reset}>
          <Plus /> New session
        </button>
      </header>

      <section className="experiment-bar">
        <div className="sample-control">
          <label htmlFor="sample">Long-context task</label>
          <select
            id="sample"
            value={sample}
            disabled={active}
            onChange={(event) => {
              const next = event.target.value as Sample;
              localStorage.setItem(SAMPLE_KEY, next);
              setSample(next);
              setRunId(crypto.randomUUID());
              setOrder(null);
            }}
          >
            {SAMPLES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} — {item.detail}
              </option>
            ))}
          </select>
          <small
            className={`mobile-run-notice${orchestrationError ? " bad" : ""}`}
            role={orchestrationError ? "alert" : undefined}
          >
            {orchestrationError ??
              (active && !baselinesStarted
                ? "RLM starts first · baselines join at the first map call"
                : "Overlapping Workers AI lanes · can take several minutes")}
          </small>
        </div>
        <div className="experiment-copy">
          <strong>
            {sample === "synth-frequency"
              ? "Models classify. JavaScript counts."
              : "Models find meaning. JavaScript orders and aggregates."}
          </strong>
          <span>
            {sample === "synth-frequency"
              ? "2,433 records → 22 bounded model maps → one JavaScript reduce"
              : "Direct context · Computer Workspace · Computer + ws:model"}
          </span>
          <small
            className={orchestrationError ? "bad" : undefined}
            role={orchestrationError ? "alert" : undefined}
          >
            {orchestrationError ?? runNotice}
          </small>
        </div>
        <button
          className={`run-button${active ? " cancel" : ""}`}
          type="button"
          disabled={cancelling}
          onClick={() => void (active ? cancelExperiment() : run())}
        >
          {cancelling ? (
            <CircleNotch className="spin" />
          ) : active ? (
            <Stop weight="fill" />
          ) : (
            <ArrowUp weight="bold" />
          )}
          {cancelling
            ? "Cancelling…"
            : active
              ? `Cancel comparison · ${finished}/3`
              : completed
                ? "Run again"
                : "Run comparison"}
        </button>
      </section>

      <section className="lane-grid">
        <Lane
          state={direct}
          messages={directChat.messages}
          transport={directChat.status}
          waiting={active && !startedLanes.has("direct")}
          onStop={() => stopLane("direct", () => directChat.stop())}
        />
        <Lane
          state={executor}
          messages={executorChat.messages}
          transport={executorChat.status}
          waiting={active && !startedLanes.has("executor")}
          onStop={() => stopLane("executor", () => executorChat.stop())}
        />
        <Lane
          state={rlm}
          messages={rlmChat.messages}
          transport={rlmChat.status}
          waiting={false}
          onStop={() => stopLane("rlm", () => rlmChat.stop())}
        />
      </section>
    </main>
  );
}

function Lane({
  state,
  messages,
  transport,
  waiting,
  onStop,
}: {
  state: BenchmarkAgentState;
  messages: UIMessage[];
  transport: string;
  waiting: boolean;
  onStop(): void;
}) {
  const run = state.run;
  const metric = run?.metrics;
  const execution = latestExecution(messages);
  const showsSemanticMismatch =
    state.lane === "executor" &&
    run?.sample.dataset === "oolongbench/oolong-synth" &&
    run.sample.row === 1200 &&
    run.score?.score === 0;
  const running =
    state.status === "loading" ||
    state.status === "running" ||
    transport === "streaming" ||
    transport === "submitted";
  const descriptions: Record<
    BenchmarkLane,
    { kicker: string; title: string; description: string; icon: React.ReactNode }
  > = {
    direct: {
      kicker: "Full-context baseline",
      title: "Direct context",
      description: "One model call receives the complete corpus and answers in one pass.",
      icon: <Database weight="duotone" />,
    },
    executor: {
      kicker: "Computer baseline",
      title: "JavaScript only",
      description:
        "Generated code can read every record, but it cannot ask what each record means.",
      icon: <Code weight="duotone" />,
    },
    rlm: {
      kicker: "Computer + ws:model",
      title: "Structured RLM",
      description:
        "Generated code asks model workers to interpret partitions, then combines their JSON.",
      icon: <GitBranch weight="duotone" />,
    },
  };
  const copy = descriptions[state.lane];
  const flowSteps =
    state.lane === "direct"
      ? ["Corpus", "Parent model", "Answer"]
      : state.lane === "executor"
        ? ["Workspace", "Generated JS", "Answer"]
        : ["Workspace", `${run?.sample.chunkCount ?? "Bounded"} map calls`, "JS reduce", "Answer"];
  return (
    <article className={`lane lane-${state.lane}`}>
      <header className="lane-header">
        <div className="lane-icon">{copy.icon}</div>
        <div>
          <span>{copy.kicker}</span>
          <h2>{copy.title}</h2>
          <p>{copy.description}</p>
          <div className="strategy-flow">
            {flowSteps.map((step, index) => (
              <span key={step}>
                {index > 0 ? <i>→</i> : null}
                <b>{step}</b>
              </span>
            ))}
          </div>
        </div>
        <div className={`status status-${state.status}`}>{state.status}</div>
      </header>
      <div className="metrics">
        <Metric
          label="score"
          value={run?.score ? `${Math.round(run.score.score * 100)}%` : "—"}
          accent
        />
        <Metric label="parent tokens" value={formatNumber(metric?.parent.totalTokens)} />
        <Metric label="map tokens" value={formatNumber(metric?.children.totalTokens)} />
        <Metric label="total tokens" value={formatNumber(metric?.combined.totalTokens)} />
        <Metric label="duration" value={formatDuration(metric?.durationMs)} />
      </div>
      <div className="lane-body">
        {!run && !state.error ? (
          <div className="empty">
            <div>{copy.icon}</div>
            <strong>{waiting ? "Waiting for the RLM map" : "Ready to run"}</strong>
            <span>
              {waiting
                ? "This baseline starts as soon as the first bounded map call begins."
                : copy.description}
            </span>
          </div>
        ) : null}
        {running ? (
          <div className="working">
            <CircleNotch className="spin" />
            <div>
              <strong>
                {state.status === "loading" ? "Loading task corpus" : "Strategy is running"}
              </strong>
              <span>
                {state.lane === "rlm"
                  ? `${state.children.filter((child) => child.status === "completed").length}/${run?.sample.chunkCount ?? state.children.length} map workers complete`
                  : state.lane === "executor"
                    ? "The parent is authoring and running a complete JavaScript module"
                    : "The parent model is reading the complete corpus"}
              </span>
            </div>
            <button type="button" onClick={onStop}>
              <Stop weight="fill" /> Stop current
            </button>
          </div>
        ) : null}
        {run ? (
          <section className="sample-card">
            <span>Task</span>
            <strong>{run.sample.question}</strong>
            <div>
              <small>
                {datasetLabel(run.sample.dataset)} · row {run.sample.row}
              </small>
              <small>{formatBytes(run.sample.contextBytes)} corpus</small>
              <small>{run.sample.chunkCount} partitions</small>
            </div>
          </section>
        ) : null}
        {state.children.length ? (
          <section className="children">
            <header>
              <div>
                <span>Model map</span>
                <small>Bounded model workers interpret independent Workspace partitions.</small>
              </div>
              <strong>
                {state.children.filter((child) => child.status === "completed").length}/
                {state.children.length} complete
              </strong>
            </header>
            <div className="worker-grid">
              {state.children.map((child) => (
                <div className={`worker worker-${child.status}`} key={child.id}>
                  <div>
                    <i className={`dot dot-${child.status}`} />
                    <strong>Map {String(child.index + 1).padStart(2, "0")}</strong>
                  </div>
                  <small>{formatDuration(child.durationMs)}</small>
                  <small>{formatNumber(child.usage.totalTokens)} tokens</small>
                  {child.error ? <span>{child.error}</span> : null}
                </div>
              ))}
            </div>
            <footer>
              <Code weight="duotone" />
              <span>Validated model JSON</span>
              <i>→</i>
              <strong>JavaScript reduce</strong>
            </footer>
          </section>
        ) : null}
        {run?.score ? (
          <section className="answer">
            <span>Oolong score</span>
            <strong>{Math.round(run.score.score * 100)}%</strong>
            <div>
              <small>Reference answer</small>
              <code>{formatValue(run.score.answer)}</code>
            </div>
            <div>
              <small>Strategy answer</small>
              <code>{formatValue(run.score.attemptedParse)}</code>
            </div>
          </section>
        ) : null}
        {execution ? (
          <>
            <details className="execution">
              <summary>
                {state.lane === "rlm" ? "Generated map/reduce module" : "Generated executor module"}
                {" · "}
                {formatBytes(new TextEncoder().encode(execution.source).byteLength)}
              </summary>
              <pre>{execution.source}</pre>
            </details>
            {execution.result !== undefined ? (
              <section className="result">
                <span>
                  {state.lane === "rlm"
                    ? "JavaScript reducer output"
                    : "JavaScript execution output"}
                </span>
                <pre>{formatValue(execution.result)}</pre>
              </section>
            ) : null}
          </>
        ) : null}
        {showsSemanticMismatch ? (
          <section className="capability-note">
            <span>Capability mismatch</span>
            <strong>JavaScript completed, but its output does not fit this task.</strong>
            <p>
              The records need semantic labels before code can count them. This lane has no model
              capability; Structured RLM adds bounded <code>ws:model</code> map calls.
            </p>
          </section>
        ) : null}
        {state.error ? (
          <div className="error">
            <Warning weight="fill" /> {state.error}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function Metric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className={accent ? "accent" : ""}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function AccessGate({
  checking,
  onUnlock,
}: {
  checking: boolean;
  onUnlock(token: string): Promise<string | null>;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="access">
      <div>
        <LockKey weight="duotone" />
        <span>Computer RLM</span>
        <h1>{checking ? "Checking access…" : "Enter the demo token"}</h1>
        {checking ? (
          <CircleNotch className="spin" />
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              void onUnlock(token)
                .then(setError)
                .catch(() =>
                  setError("The demo could not verify access. Check the connection and retry."),
                )
                .finally(() => setBusy(false));
            }}
          >
            <input
              type="password"
              value={token}
              aria-label="Demo token"
              autoComplete="off"
              onChange={(event) => setToken(event.target.value)}
              placeholder="Demo token"
              required
            />
            <button type="submit" disabled={busy || !token}>
              {busy ? <CircleNotch className="spin" /> : "Continue"}
            </button>
          </form>
        )}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </main>
  );
}

function latestExecution(messages: UIMessage[]): { source: string; result?: unknown } | null {
  let latest: { source: string; result?: unknown } | null = null;
  for (const message of messages)
    for (const part of message.parts) {
      if (part.type !== "tool-executor") continue;
      const input = "input" in part && isRecord(part.input) ? part.input : null;
      const output = "output" in part && isRecord(part.output) ? part.output : null;
      if (typeof input?.command === "string")
        latest = { source: input.command, result: output?.result };
    }
  return latest;
}

function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
function formatNumber(value: number | null | undefined): string {
  return value == null ? "—" : value.toLocaleString();
}
function formatDuration(value: number | null | undefined): string {
  return value == null ? "—" : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}
function datasetLabel(dataset: OolongSampleMetadata["dataset"]): string {
  return dataset === "oolongbench/oolong-synth" ? "Oolong synth" : "Oolong real";
}
function formatBytes(value: number): string {
  return value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isLocalHost(): boolean {
  return (
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "[::1]"
  );
}
function getStoredSample(): Sample {
  const value = localStorage.getItem(SAMPLE_KEY);
  return SAMPLES.some((sample) => sample.id === value) ? (value as Sample) : "synth-frequency";
}
function getOrCreateSessionId(): string {
  const value = localStorage.getItem(SESSION_KEY);
  if (value) return value;
  const created = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, created);
  return created;
}
