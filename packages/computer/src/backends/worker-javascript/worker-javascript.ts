import type { WorkspaceBackendHost } from "../../backend.js";
import { WorkspaceRuntimeBridge } from "../../runtime/bridge.js";
import { assertRuntimeValue, WorkspaceRuntimeCapability } from "../../runtime/capability.js";
import {
  dynamicWorkerEgress,
  hostEgressFetch,
  type WorkspaceEgressPolicy,
} from "../../runtime/egress.js";
import type {
  ModuleExecutionEnvelope,
  ModuleExecutionInput,
  WorkspaceModule,
  WorkspaceModuleBackend,
  WorkspaceModuleBackendHandle,
  WorkspaceModuleBackendHost,
  WorkspaceModuleFunctions,
  WorkspaceRuntimeAccess,
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeInterruptPolicy,
  WorkspaceRuntimeLoader,
  WorkspaceRuntimeValue,
} from "../../runtime/types.js";
import { decodeRuntimeFrames, type RuntimeFrame } from "./frames.js";
import {
  clearResume,
  createResumeTables,
  RESUME_TABLES,
  ExecutionJournal,
  fingerprint,
  fromBase64,
  INTERRUPT_POLICIES,
  JOURNAL_VERSION,
  loadResume,
  MAX_CONCURRENT_RECOVERIES,
  journaledCalls,
  MAX_INTERRUPT_ATTEMPTS,
  recordAttempt,
  REPLAY_VERSION,
  saveResume,
  toBase64,
} from "./journal.js";
import {
  assertHostModuleExports,
  buildModuleGraph,
  hasNodeModules,
  internalModuleSources,
  NODE_MODULES_DESCRIPTION,
  type ParsedModules,
  parseModules,
  prepareSourceModules,
} from "./module-graph.js";

export interface WorkerJavaScriptBackendOptions {
  loader: WorkspaceRuntimeLoader;
  id?: string;
  root?: string;
  access?: WorkspaceRuntimeAccess;
  /**
   * Modules caller source can import by specifier.
   *
   * A string value is JavaScript source bundled into the isolate, such as
   * a library build. An object of functions, or a factory that builds
   * one, is a host module: it runs in the Durable Object under a `ws:*`
   * specifier, and each function becomes a named export.
   *
   * ```ts
   * modules: {
   *   "tar-stream": TAR_STREAM_BUNDLE,
   *   "ws:git": createGitModule(),
   *   "ws:weather": { forecast: ([city]) => lookUpForecast(String(city)) },
   * }
   * ```
   *
   * `node:fs` and `node:fs/promises` are always installed and cannot be
   * replaced. The constructor throws when a specifier is not allowed, and
   * connecting throws when a host module's export names are not allowed.
   */
  modules?: Record<string, WorkspaceModule>;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  /**
   * The most CPU time one execution can use, in milliseconds. Each
   * execution's CPU limit is the smaller of its timeout and this value.
   * Defaults to `maxTimeoutMs`, which makes the CPU limit the timeout.
   *
   * CPU time adds up over the whole execution, however much of it is spent
   * waiting. Cloudflare currently stops a Dynamic Worker call at about five
   * minutes of CPU whatever the limit, so values above 300000 have no
   * effect.
   */
  maxCpuMs?: number;
  /**
   * What happens to a run if the Durable Object restarts under it, as on
   * a deploy or crash. A run's own `onInterrupt` overrides it. Defaults
   * to `"fail"`.
   *
   * - `"fail"` settles the run as failed.
   * - `"restart"` runs it again from the start, once the backend
   *   reconnects. Its output so far stays, so the run's output repeats.
   * - `"replay"` runs it again from the start, but answers every
   *   filesystem, host module and `fetch` call it already made from a
   *   journal instead of running it again, in the order the responses
   *   first arrived. Its clock, timers and random numbers replay too.
   *   Output already recorded isn't repeated. If the run takes a
   *   different path, it fails.
   *
   * A run is resumed when the backend reconnects, which the next
   * runtime call, `ready({ all: true })` or `runtime.recover()`
   * triggers. It gets three attempts, counted again each time it
   * journals a call, and must finish within its original timeout. A
   * call in flight at the interruption runs again, unless it's marked
   * with `unsafeToRepeat()`.
   *
   * `"restart"` and `"replay"` are experimental and may change in any
   * release.
   */
  onInterrupt?: WorkspaceRuntimeInterruptPolicy;
  /**
   * How often to schedule a timer while any execution is running, in
   * milliseconds. Set it to 0 to turn the timer off. Defaults to 60
   * seconds.
   *
   * From compatibility date 2026-10-01, each piece of pending work keeps
   * a Durable Object in memory for at most 15 minutes from when it starts.
   * An execution is one call into a Dynamic Worker, so one that goes
   * quiet, making no host calls and printing nothing, is evicted about 15
   * minutes after it starts, and the eviction ends it. Host calls and
   * output also keep the object in memory while they keep coming, but an
   * execution can't be relied on to make them. Every timer counts as new
   * pending work, so a timer that keeps rescheduling holds the object in
   * memory for as long as an execution is running. The interval must be
   * under 15 minutes.
   *
   * The backend reads the host Worker's compatibility flags and schedules
   * the timer only where it helps, from 2026-10-01 or with
   * `durable_object_io_tasks_prevent_eviction`.
   *
   * An execution stops counting once its timeout plus `maxHostCallMs` has
   * passed, even if it is still waiting for a host call to settle, so a
   * host module that never settles can't keep the object in memory
   * indefinitely. While the timer runs, the object is billed for duration
   * and can't hibernate.
   *
   * On earlier compatibility dates, pending work and timers do not keep a
   * Durable Object in memory, so no timer is scheduled, and an execution
   * that outlives the request that started it is evicted after about a
   * minute. A host on an earlier date needs its own keep-alive, such as an
   * alarm.
   */
  keepAliveIntervalMs?: number;
  maxSourceBytes?: number;
  maxInputBytes?: number;
  maxStdinBytes?: number;
  maxEnvBytes?: number;
  maxResultBytes?: number;
  maxStdioBytes?: number;
  maxCapabilityBytes?: number;
  /** Caller-visible deadline for one host capability call. */
  maxHostCallMs?: number;
  maxConcurrentCapabilityCalls?: number;
  maxCapabilityCalls?: number;
  maxCapabilityRequestBytes?: number;
  maxCapabilityResponseBytes?: number;
  /** Maximum entries returned by one isolated directory read. Defaults to 1024. */
  maxDirectoryEntries?: number;
  /** Maximum live replay subscribers per execution. Defaults to 8. */
  maxExecutionSubscribers?: number;
  /** Completed execution retention window. Defaults to 60 minutes. */
  retentionMs?: number;
  /** Maximum completed executions retained per backend. Defaults to 100. */
  maxRetainedExecutions?: number;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  egress?: WorkspaceEgressPolicy;
  globalOutbound?: Fetcher | null;
}

type ResolvedWorkerJavaScriptBackendOptions = Required<
  Pick<
    WorkerJavaScriptBackendOptions,
    | "root"
    | "access"
    | "defaultTimeoutMs"
    | "maxTimeoutMs"
    | "maxCpuMs"
    | "onInterrupt"
    | "keepAliveIntervalMs"
    | "maxSourceBytes"
    | "maxInputBytes"
    | "maxStdinBytes"
    | "maxEnvBytes"
    | "maxResultBytes"
    | "maxStdioBytes"
    | "maxCapabilityBytes"
    | "maxHostCallMs"
    | "maxConcurrentCapabilityCalls"
    | "maxCapabilityCalls"
    | "maxCapabilityRequestBytes"
    | "maxCapabilityResponseBytes"
    | "maxDirectoryEntries"
    | "maxExecutionSubscribers"
    | "retentionMs"
    | "maxRetainedExecutions"
    | "compatibilityDate"
    | "compatibilityFlags"
  >
> &
  Omit<WorkerJavaScriptBackendOptions, "egress" | "globalOutbound" | "modules"> & {
    egress: WorkspaceEgressPolicy;
    modules: ParsedModules;
  };

interface WorkspaceExecutionContext {
  env: Record<string, string>;
  cwd: string;
  stdin: Uint8Array;
  // Set for a replayable run: the seed for its random numbers, the time
  // its clock starts at, and the order it saw its events in before it was
  // interrupted, which is empty on the first attempt.
  durable?: { seed: string; startedAt: number; schedule: number[] };
}

interface JavaScriptEntrypoint {
  evaluate(
    input: WorkspaceRuntimeValue,
    host: WorkspaceRuntimeBridge,
    context: WorkspaceExecutionContext,
  ): Promise<void>;
  [Symbol.dispose]?: () => void;
}

interface ActiveControl {
  cancel(): void;
  readonly completion: Promise<void>;
}

interface ExecutionSubscriber {
  controller: ReadableStreamDefaultController<WorkspaceRuntimeEvent>;
  index: number;
  release(): void;
}

interface ExecutionRecord {
  id: string;
  events: WorkspaceRuntimeEvent[];
  subscribers: Set<ExecutionSubscriber>;
  status: "running" | "completed" | "failed" | "cancelled";
  control?: ActiveControl;
  bridge?: WorkspaceRuntimeBridge;
  finalization?: Promise<void>;
  persistenceFailed?: boolean;
  result?: WorkspaceRuntimeValue;
  hasResult?: boolean;
  exitCode?: number;
  journal?: ExecutionJournal;
  // Output a replayed run already recorded. Its frames must repeat these
  // bytes, which the record checks and doesn't append again.
  replayed?: Record<"stdout" | "stderr", { bytes: Uint8Array; offset: number }>;
}

export class WorkerJavaScriptBackend implements WorkspaceModuleBackend {
  readonly protocol = "module" as const;
  readonly type = "worker-javascript";
  readonly callable = true;
  readonly id: string;
  readonly #options: ResolvedWorkerJavaScriptBackendOptions;
  readonly #header: string;

  constructor(options: WorkerJavaScriptBackendOptions) {
    this.id = options.id ?? "worker-javascript";
    if (options.egress !== undefined && options.globalOutbound !== undefined) {
      throw new Error("WorkerJavaScriptBackend cannot use globalOutbound together with egress.");
    }
    const maxTimeoutMs = options.maxTimeoutMs ?? 180_000;
    const defaultTimeoutMs = options.defaultTimeoutMs ?? Math.min(60_000, maxTimeoutMs);
    assertPositiveFinite(maxTimeoutMs, "maxTimeoutMs");
    assertPositiveFinite(defaultTimeoutMs, "defaultTimeoutMs");
    const maxCpuMs = options.maxCpuMs ?? maxTimeoutMs;
    assertPositiveFinite(maxCpuMs, "maxCpuMs");
    const onInterrupt = options.onInterrupt ?? "fail";
    assertInterruptPolicy(onInterrupt);
    const keepAliveIntervalMs = options.keepAliveIntervalMs ?? 60_000;
    // Pending work protects a Durable Object for at most 15 minutes, so a
    // longer interval would leave gaps.
    if (
      !Number.isFinite(keepAliveIntervalMs) ||
      keepAliveIntervalMs < 0 ||
      keepAliveIntervalMs >= 900_000
    ) {
      throw new Error(
        "WorkerJavaScriptBackend keepAliveIntervalMs must be zero or less than 15 minutes.",
      );
    }
    assertPositiveFinite(options.maxSourceBytes ?? 1024 * 1024, "maxSourceBytes");
    assertPositiveFinite(options.maxInputBytes ?? 1024 * 1024, "maxInputBytes");
    assertPositiveFinite(options.maxStdinBytes ?? 256 * 1024, "maxStdinBytes");
    assertPositiveFinite(options.maxEnvBytes ?? 1024 * 1024, "maxEnvBytes");
    assertPositiveFinite(options.maxResultBytes ?? 1024 * 1024, "maxResultBytes");
    assertPositiveFinite(options.maxStdioBytes ?? 1024 * 1024, "maxStdioBytes");
    assertPositiveFinite(options.maxCapabilityBytes ?? 1024 * 1024, "maxCapabilityBytes");
    assertPositiveFinite(options.maxHostCallMs ?? maxTimeoutMs, "maxHostCallMs");
    assertPositiveInteger(
      options.maxConcurrentCapabilityCalls ?? 32,
      "maxConcurrentCapabilityCalls",
    );
    assertPositiveInteger(options.maxCapabilityCalls ?? 256, "maxCapabilityCalls");
    assertPositiveFinite(
      options.maxCapabilityRequestBytes ?? 8 * 1024 * 1024,
      "maxCapabilityRequestBytes",
    );
    assertPositiveFinite(
      options.maxCapabilityResponseBytes ?? 8 * 1024 * 1024,
      "maxCapabilityResponseBytes",
    );
    assertPositiveInteger(options.maxDirectoryEntries ?? 1024, "maxDirectoryEntries");
    assertPositiveInteger(options.maxExecutionSubscribers ?? 8, "maxExecutionSubscribers");
    assertPositiveFinite(options.retentionMs ?? 60 * 60_000, "retentionMs");
    assertPositiveInteger(options.maxRetainedExecutions ?? 100, "maxRetainedExecutions");
    if ((options.maxCapabilityBytes ?? 1024 * 1024) < 256) {
      throw new Error("WorkerJavaScriptBackend maxCapabilityBytes must be at least 256 bytes.");
    }
    const compatibilityDate = options.compatibilityDate ?? "2026-05-23";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)) {
      throw new Error("WorkerJavaScriptBackend compatibilityDate must use YYYY-MM-DD.");
    }
    if (defaultTimeoutMs > maxTimeoutMs) {
      throw new Error("WorkerJavaScriptBackend defaultTimeoutMs cannot exceed maxTimeoutMs.");
    }
    const { globalOutbound, egress, ...backendOptions } = options;
    const resolvedEgress =
      egress ??
      (globalOutbound === undefined
        ? { mode: "none" as const }
        : globalOutbound === null
          ? { mode: "none" as const }
          : { mode: "http-gateway" as const, gateway: globalOutbound });
    this.#options = {
      ...backendOptions,
      egress: resolvedEgress,
      modules: parseModules(options.modules ?? {}),
      root: options.root ?? "/workspace",
      access: options.access ?? "read-write",
      defaultTimeoutMs,
      maxTimeoutMs,
      maxCpuMs,
      onInterrupt,
      keepAliveIntervalMs,
      maxSourceBytes: options.maxSourceBytes ?? 1024 * 1024,
      maxInputBytes: options.maxInputBytes ?? 1024 * 1024,
      maxStdinBytes: options.maxStdinBytes ?? 256 * 1024,
      maxEnvBytes: options.maxEnvBytes ?? 1024 * 1024,
      maxResultBytes: options.maxResultBytes ?? 1024 * 1024,
      maxStdioBytes: options.maxStdioBytes ?? 1024 * 1024,
      maxCapabilityBytes: options.maxCapabilityBytes ?? 1024 * 1024,
      maxHostCallMs: options.maxHostCallMs ?? maxTimeoutMs,
      maxConcurrentCapabilityCalls: options.maxConcurrentCapabilityCalls ?? 32,
      maxCapabilityCalls: options.maxCapabilityCalls ?? 256,
      maxCapabilityRequestBytes: options.maxCapabilityRequestBytes ?? 8 * 1024 * 1024,
      maxCapabilityResponseBytes: options.maxCapabilityResponseBytes ?? 8 * 1024 * 1024,
      maxDirectoryEntries: options.maxDirectoryEntries ?? 1024,
      maxExecutionSubscribers: options.maxExecutionSubscribers ?? 8,
      retentionMs: options.retentionMs ?? 60 * 60_000,
      maxRetainedExecutions: options.maxRetainedExecutions ?? 100,
      compatibilityDate,
      compatibilityFlags: options.compatibilityFlags ?? ["nodejs_compat"],
    };
    this.#header = [
      "`command` is ECMAScript module source, run in an isolated JavaScript runtime. Relative imports resolve from `cwd` in the workspace.",
      "Put the work in `export default async function (input) { ... }` and call `node:fs` and the other modules below inside it, since the module's top level can't do I/O. To run a file you've already written, re-export it: `export { default } from \"./main.js\"`.",
      ...(resolvedEgress.mode === "none" ? ["Code has no direct network access."] : []),
      ...(this.#options.access === "read" ? ["The workspace is read-only here."] : []),
      "",
      "Modules code can import:",
    ].join("\n");
  }

  /** What this backend tells a model: the source language and every importable module. */
  get description(): string {
    return [
      this.#header,
      this.#options.modules.description,
      ...(hasNodeModules(this.#options.compatibilityFlags) ? [NODE_MODULES_DESCRIPTION] : []),
    ].join("\n");
  }

  async connect(host: WorkspaceModuleBackendHost): Promise<WorkspaceModuleBackendHandle> {
    return new JavaScriptBackendHandle(this.#options, host);
  }
}

class JavaScriptBackendHandle implements WorkspaceModuleBackendHandle {
  readonly #options: ResolvedWorkerJavaScriptBackendOptions;
  readonly #host: WorkspaceModuleBackendHost;
  readonly #hostModuleFunctions: ReadonlyMap<string, WorkspaceModuleFunctions>;
  readonly #emptyHostModules: ReadonlySet<string>;
  #sourceModules: Readonly<Record<string, string>> | undefined;
  readonly #records = new Map<string, ExecutionRecord>();
  readonly #pendingIds = new Set<string>();
  #closed = false;
  readonly #activeStreams = new Map<string, number>();
  #pendingStarts = 0;
  readonly #pendingStartWaiters = new Set<() => void>();
  // Running executions, each with the time after which it stops counting
  // towards the keep-alive.
  readonly #running = new Map<string, number>();
  readonly #recoveryQueue: Array<() => void> = [];
  readonly #recovering = new Set<string>();
  #keepAlive: ReturnType<typeof setInterval> | undefined;
  // Zero when the timer is off or can't keep this object in memory.
  readonly #keepAliveIntervalMs: number;

  constructor(options: ResolvedWorkerJavaScriptBackendOptions, host: WorkspaceModuleBackendHost) {
    this.#options = options;
    this.#keepAliveIntervalMs = hostKeepsPendingWork() ? options.keepAliveIntervalMs : 0;
    this.#host = host;
    const functions = new Map<string, WorkspaceModuleFunctions>();
    const empty = new Set<string>();
    for (const [specifier, factory] of options.modules.host) {
      const built = factory({
        git: host.git,
        artifacts: host.artifacts,
        runtime: host.runtime,
        ...(host.assets === undefined ? {} : { assets: host.assets }),
      });
      // A factory can have nothing to offer on a connection, such as
      // ws:tools for an agent with no tools. Leaving its module out means
      // only an import of it fails, not every run. An object of functions
      // with none is still refused at construction, where it can only be
      // a mistake.
      if (Object.keys(built).length === 0) {
        empty.add(specifier);
        continue;
      }
      assertHostModuleExports(specifier, built);
      functions.set(specifier, built);
    }
    this.#hostModuleFunctions = functions;
    this.#emptyHostModules = empty;
    host.db.run(`
      CREATE TABLE IF NOT EXISTS workspace_runtime_executions (
        backend TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        finished_at INTEGER,
        PRIMARY KEY (backend, id)
      )
    `);
    addColumnIfMissing(
      host,
      "workspace_runtime_executions",
      "created_at",
      "INTEGER NOT NULL DEFAULT 0",
    );
    addColumnIfMissing(host, "workspace_runtime_executions", "finished_at", "INTEGER");
    host.db.run(
      `UPDATE workspace_runtime_executions
       SET finished_at = ?
       WHERE status != 'running' AND finished_at IS NULL`,
      Date.now(),
    );
    host.db.run(`
      CREATE TABLE IF NOT EXISTS workspace_runtime_events (
        backend TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        name TEXT NOT NULL,
        payload BLOB NOT NULL,
        PRIMARY KEY (backend, execution_id, seq)
      )
    `);
    createResumeTables(host.db);
    this.#prune();
    const interrupted = host.db.all<{ id: string }>(
      `SELECT id FROM workspace_runtime_executions WHERE backend = ? AND status = 'running'`,
      this.#backendId,
    );
    for (const { id } of interrupted) this.#resumeInterrupted(id);
    this.#drainRecoveries();
  }

  // Recovery runs when the backend connects, so there's nothing left to
  // do by the time the runtime asks.
  async recover(): Promise<void> {}

  // Start a run the restart interrupted again, if it asked for that and
  // still can, or settle it as failed.
  #resumeInterrupted(id: string) {
    const record = this.#loadRecord(id);
    if (record?.status !== "running") return;
    this.#records.set(id, record);
    const fail = (message: string) =>
      this.#finish(record, "failed", [
        {
          id,
          seq: record.events.length + 1,
          name: "stderr",
          value: new TextEncoder().encode(`${message}\n`),
        },
        { id, seq: record.events.length + 2, name: "exit", code: 1 },
      ]);
    let saved: ReturnType<typeof loadResume>;
    try {
      saved = loadResume(this.#host.db, this.#backendId, id);
    } catch {
      saved = undefined;
    }
    if (saved === undefined) {
      fail("Execution was interrupted when its Workspace runtime restarted.");
      return;
    }
    // Attempts count from the last call the run journaled, so a long run
    // isn't failed by interruptions spread across it. Its timeout still
    // bounds how long it can keep going.
    const progressed = journaledCalls(this.#host.db, this.#backendId, id) > saved.callsAtAttempt;
    const attempt = progressed ? 1 : saved.attempt;
    if (attempt >= MAX_INTERRUPT_ATTEMPTS) {
      fail(
        `Execution was interrupted ${attempt} times without making progress and won't be started again.`,
      );
      return;
    }
    const { start } = saved;
    if (start.version !== JOURNAL_VERSION || start.fingerprint !== this.#fingerprint()) {
      fail(
        "Execution was interrupted and can't resume, because the JavaScript runtime changed since it started.",
      );
      return;
    }
    const resumable = { ...saved, attempt };
    this.#recoveryQueue.push(() => {
      if (record.status !== "running" || record.finalization) return;
      this.#recovering.add(id);
      this.#relaunch(record, resumable, fail);
    });
  }

  // A Durable Object can run only so many Dynamic Workers at once, and
  // new executions need some of them, so interrupted runs start a few at
  // a time. Each one that settles lets the next start.
  #drainRecoveries() {
    while (this.#recovering.size < MAX_CONCURRENT_RECOVERIES) {
      const next = this.#recoveryQueue.shift();
      if (next === undefined) return;
      next();
    }
  }

  #relaunch(
    record: ExecutionRecord,
    { policy, attempt, start }: NonNullable<ReturnType<typeof loadResume>>,
    fail: (message: string) => void,
  ) {
    const id = record.id;
    // A run's timeout counts from when it first started, including the
    // time it spent interrupted or waiting to resume.
    const remainingMs = start.startedAt + start.timeoutMs - Date.now();
    if (remainingMs <= 0) {
      fail("Execution was interrupted and its timeout passed before it could resume.");
      return;
    }
    try {
      recordAttempt(
        this.#host.db,
        this.#backendId,
        id,
        attempt + 1,
        journaledCalls(this.#host.db, this.#backendId, id),
      );
      let journal: ExecutionJournal | undefined;
      let durable: WorkspaceExecutionContext["durable"];
      if (policy === "replay") {
        journal = this.#journalFor(record);
        durable = { seed: start.seed, startedAt: start.startedAt, schedule: journal.schedule() };
        record.replayed = {
          stdout: { bytes: recordedOutput(record.events, "stdout"), offset: 0 },
          stderr: { bytes: recordedOutput(record.events, "stderr"), offset: 0 },
        };
      } else {
        this.#append(record, {
          id,
          seq: record.events.length + 1,
          name: "stderr",
          value: new TextEncoder().encode(
            "Execution restarted from the beginning after its Workspace runtime was interrupted.\n",
          ),
        });
      }
      void this.#launch(record, {
        capability: this.#capability(),
        modules: start.modules,
        entryName: start.entryName,
        input: start.input,
        context: {
          env: start.env,
          cwd: start.cwd,
          stdin: fromBase64(start.stdin),
          ...(durable === undefined ? {} : { durable }),
        },
        timeoutMs: remainingMs,
        cpuMs: start.cpuMs,
        journal,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  // What a run depends on to replay the same way. A run resumes only on
  // the same. The runtime's own code is covered by REPLAY_VERSION, so an
  // upgrade that doesn't change replay doesn't fail interrupted runs.
  #fingerprint(): string {
    return fingerprint([
      String(REPLAY_VERSION),
      String(this.#options.maxStdioBytes),
      String(this.#options.maxCapabilityBytes),
      this.#options.compatibilityDate,
      this.#options.compatibilityFlags.join(","),
    ]);
  }

  #journalFor(record: ExecutionRecord): ExecutionJournal {
    return new ExecutionJournal(this.#host.db, this.#backendId, record.id, (message) =>
      this.#diverge(record, message),
    );
  }

  // A replayed run called something its journal doesn't hold. Stop it
  // now, before it acts on a state the journal can't account for.
  #diverge(record: ExecutionRecord, message: string) {
    if (record.status !== "running" || record.finalization) return;
    record.control?.cancel();
    void this.#finalize(record, message);
  }

  #capability(): WorkspaceRuntimeCapability {
    return new WorkspaceRuntimeCapability(
      this.#host.fs,
      this.#options.root,
      this.#options.access,
      this.#options.maxCapabilityBytes,
      this.#options.maxDirectoryEntries,
    );
  }

  // Parsing a large bundle on every run would be wasteful, so source
  // modules are prepared once, on the first run that needs them.
  #preparedSourceModules(): Readonly<Record<string, string>> {
    this.#sourceModules ??= prepareSourceModules(
      this.#options.modules.source,
      new Set(this.#options.modules.host.keys()),
    );
    return this.#sourceModules;
  }

  async exec(input: ModuleExecutionInput): Promise<ModuleExecutionEnvelope> {
    if (this.#closed) throw runtimeError("ECLOSED", "Workspace JavaScript backend is closed");
    const id = input.id ?? crypto.randomUUID();
    assertExecutionId(id);
    this.#prune();
    if (this.#pendingIds.has(id)) {
      throw runtimeError("EEXEC_BUSY", `execution ${id} is already starting`);
    }
    const existing = this.#recordFor(id);
    if (existing?.status === "running") {
      throw runtimeError("EEXEC_BUSY", `execution ${id} is already running`);
    }
    if (existing) throw runtimeError("EEXEC_EXISTS", `execution ${id} already exists`);

    const timeoutMs = input.timeoutMs ?? this.#options.defaultTimeoutMs;
    assertPositiveFinite(timeoutMs, "timeoutMs");
    if (timeoutMs > this.#options.maxTimeoutMs) {
      throw new Error(
        `Workspace runtime timeout cannot exceed ${this.#options.maxTimeoutMs} milliseconds.`,
      );
    }
    const inputValue = input.input ?? null;
    assertRuntimeValue(inputValue);
    assertEncodedSize(inputValue, this.#options.maxInputBytes, "input");
    const stdinBytes = normalizeStdin(input.stdin);
    if (stdinBytes.byteLength > this.#options.maxStdinBytes) {
      throw new Error(`Workspace runtime stdin exceeds ${this.#options.maxStdinBytes} bytes.`);
    }
    assertEnv(input.env, this.#options.maxEnvBytes);
    const policy = input.onInterrupt ?? this.#options.onInterrupt;
    assertInterruptPolicy(policy);
    if (new TextEncoder().encode(input.source).byteLength > this.#options.maxSourceBytes) {
      throw new Error(`Workspace runtime source exceeds ${this.#options.maxSourceBytes} bytes.`);
    }
    // There is no cap on concurrent executions here: the platform limits
    // concurrent Dynamic Workers itself and reports that limit as the
    // execution's error.
    this.#pendingStarts += 1;
    this.#pendingIds.add(id);
    try {
      if (this.#options.access === "read-write")
        await ensureDirectory(this.#host.fs, this.#options.root);
      const capability = this.#capability();
      const graph = await buildModuleGraph({
        source: input.source,
        cwd: input.cwd ?? this.#options.root,
        capability,
        configuredModules: this.#preparedSourceModules(),
        hostModules: this.#hostModuleFunctions,
        emptyHostModules: this.#emptyHostModules,
        nodeModules: hasNodeModules(this.#options.compatibilityFlags),
        maxSourceBytes: this.#options.maxSourceBytes,
        maxCapabilityBytes: this.#options.maxCapabilityBytes,
      });
      if (this.#closed) {
        throw runtimeError("ECLOSED", "Workspace JavaScript backend closed during module loading");
      }
      const record: ExecutionRecord = {
        id,
        events: [],
        subscribers: new Set(),
        status: "running",
      };
      try {
        this.#host.db.run(
          `INSERT INTO workspace_runtime_executions
             (backend, id, status, created_at, finished_at)
           VALUES (?, ?, 'running', ?, NULL)`,
          this.#backendId,
          id,
          Date.now(),
        );
      } catch (error) {
        const durable = this.#recordFor(id);
        if (durable?.status === "running") {
          throw runtimeError("EEXEC_BUSY", `execution ${id} is already running`);
        }
        if (durable) throw runtimeError("EEXEC_EXISTS", `execution ${id} already exists`);
        throw error;
      }
      this.#records.set(id, record);
      const context: WorkspaceExecutionContext = {
        env: input.env ?? {},
        cwd: input.cwd ?? this.#options.root,
        stdin: stdinBytes,
      };
      const cpuMs = Math.min(timeoutMs, this.#options.maxCpuMs);
      let journal: ExecutionJournal | undefined;
      try {
        if (policy !== "fail") {
          const startedAt = Date.now();
          const seed = [...crypto.getRandomValues(new Uint8Array(32))]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          saveResume(this.#host.db, this.#backendId, id, policy, {
            version: JOURNAL_VERSION,
            modules: graph.modules,
            entryName: graph.entryName,
            input: inputValue,
            env: context.env,
            cwd: context.cwd,
            stdin: toBase64(stdinBytes),
            timeoutMs,
            cpuMs,
            startedAt,
            seed,
            fingerprint: this.#fingerprint(),
          });
          if (policy === "replay") {
            journal = this.#journalFor(record);
            context.durable = { seed, startedAt, schedule: [] };
          }
        }
      } catch (error) {
        await this.#finalize(record, error instanceof Error ? error.message : String(error));
        return { id, events: this.#stream(record) };
      }
      await this.#launch(record, {
        capability,
        modules: graph.modules,
        entryName: graph.entryName,
        input: inputValue,
        context,
        timeoutMs,
        cpuMs,
        journal,
      });
      return { id, events: this.#stream(record) };
    } finally {
      this.#pendingIds.delete(id);
      this.#pendingStarts -= 1;
      if (this.#pendingStarts === 0) {
        for (const resolve of this.#pendingStartWaiters) resolve();
        this.#pendingStartWaiters.clear();
      }
    }
  }

  // Start a run's Dynamic Worker. A failure to start settles the run.
  async #launch(
    record: ExecutionRecord,
    spec: {
      capability: WorkspaceRuntimeCapability;
      modules: Record<string, string | { js?: string }>;
      entryName: string;
      input: WorkspaceRuntimeValue;
      context: WorkspaceExecutionContext;
      timeoutMs: number;
      cpuMs: number;
      journal: ExecutionJournal | undefined;
    },
  ): Promise<void> {
    this.#markRunning(record.id, spec.timeoutMs);
    try {
      const bridge = new WorkspaceRuntimeBridge(spec.capability, {
        hostModules: this.#hostModuleFunctions,
        maxPayloadBytes: this.#options.maxCapabilityBytes,
        maxCallDurationMs: this.#options.maxHostCallMs,
        maxConcurrentCalls: this.#options.maxConcurrentCapabilityCalls,
        maxCalls: this.#options.maxCapabilityCalls,
        maxTotalRequestBytes: this.#options.maxCapabilityRequestBytes,
        maxTotalResponseBytes: this.#options.maxCapabilityResponseBytes,
        maxResultBytes: this.#options.maxResultBytes,
        onAttachOutput: (readable) => this.#pumpFrames(record, readable),
        callIdPrefix: record.id,
        ...hostEgressFetch(this.#options.egress),
        ...(spec.journal === undefined ? {} : { journal: spec.journal }),
      });
      record.bridge = bridge;
      record.journal = spec.journal;
      record.control = startJavaScriptExecution({
        loader: this.#options.loader,
        modules: spec.modules,
        entryName: spec.entryName,
        input: spec.input,
        context: spec.context,
        bridge,
        timeoutMs: spec.timeoutMs,
        cpuMs: spec.cpuMs,
        egress: this.#options.egress,
        compatibilityDate: this.#options.compatibilityDate,
        compatibilityFlags: this.#options.compatibilityFlags,
        maxStdioBytes: this.#options.maxStdioBytes,
        maxSourceBytes: this.#options.maxSourceBytes,
        onComplete: () => this.#finalize(record),
        onError: (message) => this.#finalize(record, message),
      });
      // The completion promise drives finalize (which writes the
      // terminal SQL) and is no longer handed to a host lifetime
      // hook. Observe it so a finalize rejection surfaces as a
      // swallowed error rather than an unhandled rejection in the
      // Durable Object.
      void record.control.completion.catch(() => undefined);
    } catch (error) {
      record.control?.cancel();
      await record.control?.completion.catch(() => undefined);
      await this.#finalize(record, error instanceof Error ? error.message : String(error));
    }
  }

  async getExec(input: { id: string; after?: number | "tail" }): Promise<ModuleExecutionEnvelope> {
    assertExecutionId(input.id);
    this.#prune();
    const record = this.#recordFor(input.id);
    if (!record) throw runtimeError("ENOENT", `no such execution: ${input.id}`);
    return { id: input.id, events: this.#stream(record, input.after) };
  }

  async killExec(input: { id: string }): Promise<void> {
    assertExecutionId(input.id);
    const record = this.#recordFor(input.id);
    if (!record) throw runtimeError("ENOENT", `no such execution: ${input.id}`);
    await this.#cancel(record, "Execution cancelled.\n");
  }

  async disposeExec(input: { id: string }): Promise<void> {
    assertExecutionId(input.id);
    const record = this.#recordFor(input.id);
    if (!record) throw runtimeError("ENOENT", `no such execution: ${input.id}`);
    if (record.status === "running") {
      throw runtimeError("EEXEC_BUSY", `execution ${input.id} is still running`);
    }
    this.#host.db.transactionSync(() => {
      this.#host.db.run(
        `DELETE FROM workspace_runtime_events WHERE backend = ? AND execution_id = ?`,
        this.#backendId,
        input.id,
      );
      this.#host.db.run(
        `DELETE FROM workspace_runtime_executions WHERE backend = ? AND id = ?`,
        this.#backendId,
        input.id,
      );
    });
    this.#records.delete(input.id);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#pendingStarts > 0) {
      await new Promise<void>((resolve) => this.#pendingStartWaiters.add(resolve));
    }
    const records = [...this.#records.values()];
    const finalizations = records.map((record) =>
      record.status === "running"
        ? this.#cancel(record, "Execution cancelled because its Workspace closed.\n")
        : (record.finalization ?? Promise.resolve()),
    );
    await Promise.allSettled(finalizations);
    for (const record of records) this.#close(record);
    this.#records.clear();
    this.#running.clear();
    this.#syncKeepAlive();
  }

  // An execution normally settles by its timeout. Finalizing then waits
  // for host calls it already accepted, which can take up to
  // `maxHostCallMs` for a well-behaved host module. A run still going past
  // both stops counting, so a host module that never settles can't keep
  // the object in memory indefinitely.
  #markRunning(id: string, timeoutMs: number) {
    this.#running.set(id, Date.now() + timeoutMs + this.#options.maxHostCallMs);
    this.#syncKeepAlive();
  }

  #markSettled(id: string) {
    this.#running.delete(id);
    this.#syncKeepAlive();
    if (this.#recovering.delete(id)) this.#drainRecoveries();
  }

  // Hold the Durable Object in memory while any execution runs. Scheduling
  // the timer is what counts as pending work; when it fires it only drops
  // executions past their keep-alive deadline. See `keepAliveIntervalMs`.
  #syncKeepAlive() {
    if (this.#running.size > 0 && this.#keepAliveIntervalMs > 0) {
      this.#keepAlive ??= setInterval(() => this.#expireKeepAlive(), this.#keepAliveIntervalMs);
    } else if (this.#keepAlive !== undefined) {
      clearInterval(this.#keepAlive);
      this.#keepAlive = undefined;
    }
  }

  #expireKeepAlive() {
    const now = Date.now();
    for (const [id, until] of this.#running) {
      if (now > until) this.#running.delete(id);
    }
    this.#syncKeepAlive();
  }

  get #backendId(): string {
    return this.#options.id ?? "worker-javascript";
  }

  async #cancel(record: ExecutionRecord, message: string): Promise<void> {
    if (record.finalization) return record.finalization;
    if (record.status !== "running") return;
    const finalization = (async () => {
      record.control?.cancel();
      try {
        await record.bridge?.cancelAndDrain();
      } catch (error) {
        this.#finish(record, "failed", [
          {
            id: record.id,
            seq: record.events.length + 1,
            name: "stderr",
            value: new TextEncoder().encode(
              `${error instanceof Error ? error.message : String(error)}\n`,
            ),
          },
          { id: record.id, seq: record.events.length + 2, name: "exit", code: 1 },
        ]);
        return;
      }
      this.#finish(record, "cancelled", [
        {
          id: record.id,
          seq: record.events.length + 1,
          name: "stderr",
          value: new TextEncoder().encode(message),
        },
        { id: record.id, seq: record.events.length + 2, name: "exit", code: 130 },
      ]);
    })();
    record.finalization = finalization;
    return finalization;
  }

  #recordFor(id: string): ExecutionRecord | undefined {
    const cached = this.#records.get(id);
    if (cached) return cached;
    const record = this.#loadRecord(id);
    if (record?.status === "running") {
      // Every live execution is cached before its Dynamic Worker starts,
      // and recovery caches the ones it resumes. A durable running row
      // without a cached record is therefore an orphan left by a failed
      // terminal transaction.
      this.#records.set(id, record);
      this.#finish(record, "failed", [
        {
          id,
          seq: record.events.length + 1,
          name: "stderr",
          value: new TextEncoder().encode(
            "Execution was interrupted when its Workspace runtime restarted or before its terminal state was persisted.\n",
          ),
        },
        { id, seq: record.events.length + 2, name: "exit", code: 1 },
      ]);
    }
    return record;
  }

  #loadRecord(id: string): ExecutionRecord | undefined {
    const row = this.#host.db.one<{ status: ExecutionRecord["status"] }>(
      `SELECT status FROM workspace_runtime_executions WHERE backend = ? AND id = ?`,
      this.#backendId,
      id,
    );
    if (!row) return undefined;
    const events = this.#host.db
      .all<{ seq: number; name: WorkspaceRuntimeEvent["name"]; payload: Uint8Array }>(
        `SELECT seq, name, payload FROM workspace_runtime_events
         WHERE backend = ? AND execution_id = ? ORDER BY seq`,
        this.#backendId,
        id,
      )
      .map((event) => decodeEvent(id, event.seq, event.name, event.payload));
    return { id, status: row.status, events, subscribers: new Set() };
  }

  // Drain the runner's framed output stream live, ingesting each frame
  // as it arrives. Resolves when the stream closes, which is the
  // signal the runner's evaluate awaits before returning.
  async #pumpFrames(record: ExecutionRecord, readable: ReadableStream<Uint8Array>) {
    const reader = decodeRuntimeFrames(readable).getReader();
    try {
      while (true) {
        let next: ReadableStreamReadResult<RuntimeFrame>;
        try {
          next = await reader.read();
        } catch (error) {
          // Timeout or cancellation disposes the Dynamic Worker while this
          // pump may be blocked on read(); the disposed isolate errors the
          // transferred stream and the read rejects. When that rejection
          // arrives after the record has already settled, treat it as a
          // normal end-of-drain. When it arrives while the execution is
          // still running it is re-thrown: on the timeout/cancel path that
          // is harmless (it rejects the already-lost evaluate race, which
          // run.catch swallows, and cancelAndDrain never awaits this pump),
          // while on a genuine mid-run stream fault it correctly surfaces
          // as a failed terminal.
          if (record.status !== "running") break;
          throw error;
        }
        if (next.done) break;
        this.#ingestFrame(record, next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  // Append a stdout/stderr frame the moment it arrives, so output is
  // observable before user code returns. Result and exit ride the same
  // stream but only settle the terminal state in #finalize.
  #ingestFrame(record: ExecutionRecord, frame: RuntimeFrame) {
    if (record.status !== "running") return;
    // Saved with the output in one transaction, so output never outlives
    // the log of the events that led to it.
    if (frame.log !== undefined) {
      try {
        record.journal?.record(frame.log.from, frame.log.events);
      } catch (error) {
        this.#diverge(record, error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (frame.name === "stdout" || frame.name === "stderr") {
      let value = frame.value;
      const replayed = record.replayed?.[frame.name];
      if (replayed !== undefined && replayed.offset < replayed.bytes.byteLength) {
        const end = Math.min(replayed.bytes.byteLength, replayed.offset + value.byteLength);
        const expected = replayed.bytes.subarray(replayed.offset, end);
        if (!bytesEqual(value.subarray(0, expected.byteLength), expected)) {
          this.#diverge(
            record,
            "The execution took a different path when it resumed after an interruption: " +
              `it wrote different ${frame.name} from the first time.`,
          );
          return;
        }
        replayed.offset = end;
        value = value.subarray(expected.byteLength);
        if (value.byteLength === 0) return;
      }
      this.#append(record, {
        id: record.id,
        seq: record.events.length + 1,
        name: frame.name,
        value,
      });
    } else {
      record.exitCode = frame.code;
      if ("result" in frame) {
        record.result = frame.result;
        record.hasResult = true;
      }
    }
  }

  #finalize(record: ExecutionRecord, errorMessage?: string): Promise<void> {
    if (record.finalization) return record.finalization;
    if (record.status !== "running") return Promise.resolve();
    const finalization = this.#finalizeOnce(record, errorMessage);
    record.finalization = finalization;
    return finalization;
  }

  async #finalizeOnce(record: ExecutionRecord, errorMessage?: string) {
    const expected = record.journal?.expectedCall();
    if (errorMessage === undefined && expected !== undefined) {
      errorMessage =
        "The execution took a different path when it resumed after an interruption: " +
        `it finished without calling ${expected} again.`;
    }
    const unwritten = (["stdout", "stderr"] as const).find((name) => {
      const replayed = record.replayed?.[name];
      return replayed !== undefined && replayed.offset < replayed.bytes.byteLength;
    });
    if (errorMessage === undefined && unwritten !== undefined) {
      errorMessage =
        "The execution took a different path when it resumed after an interruption: " +
        `it finished without writing all the ${unwritten} it wrote the first time.`;
    }
    try {
      await record.bridge?.cancelAndDrain();
    } catch (error) {
      this.#finish(record, "failed", [
        {
          id: record.id,
          seq: record.events.length + 1,
          name: "stderr",
          value: new TextEncoder().encode(
            `${error instanceof Error ? error.message : String(error)}\n`,
          ),
        },
        { id: record.id, seq: record.events.length + 2, name: "exit", code: 1 },
      ]);
      return;
    }
    if (errorMessage !== undefined) {
      this.#finish(record, "failed", [
        {
          id: record.id,
          seq: record.events.length + 1,
          name: "stderr",
          value: new TextEncoder().encode(
            `${truncateUtf8(errorMessage, Math.max(0, this.#options.maxStdioBytes - 1))}\n`,
          ),
        },
        { id: record.id, seq: record.events.length + 2, name: "exit", code: 1 },
      ]);
      return;
    }
    // No exit frame means the runner never reported a terminal state:
    // the output stream closed early, a frame write was dropped, or the
    // isolate crashed. Settle as a failure rather than a silent exit 0
    // with no result.
    if (record.exitCode === undefined) {
      this.#finish(record, "failed", [
        {
          id: record.id,
          seq: record.events.length + 1,
          name: "stderr",
          value: new TextEncoder().encode("Execution ended without reporting a result.\n"),
        },
        { id: record.id, seq: record.events.length + 2, name: "exit", code: 1 },
      ]);
      return;
    }
    const exitCode = record.exitCode;
    const exit: WorkspaceRuntimeEvent =
      exitCode === 0 && record.hasResult
        ? {
            id: record.id,
            seq: record.events.length + 1,
            name: "exit",
            code: exitCode,
            result: record.result as WorkspaceRuntimeValue,
          }
        : { id: record.id, seq: record.events.length + 1, name: "exit", code: exitCode };
    this.#finish(record, exitCode === 0 ? "completed" : "failed", [exit]);
  }

  #stream(record: ExecutionRecord, after?: number | "tail") {
    const afterSeq = after === "tail" ? (record.events.at(-1)?.seq ?? 0) : (after ?? 0);
    let released = false;
    const subscriber: ExecutionSubscriber = {
      controller: undefined as never,
      index: record.events.findIndex((event) => event.seq > afterSeq),
      release: () => {
        if (released) return;
        released = true;
        const remaining = (this.#activeStreams.get(record.id) ?? 1) - 1;
        if (remaining === 0) this.#activeStreams.delete(record.id);
        else this.#activeStreams.set(record.id, remaining);
      },
    };
    if (subscriber.index === -1) subscriber.index = record.events.length;
    return new ReadableStream<WorkspaceRuntimeEvent>({
      start: (controller) => {
        subscriber.controller = controller;
        const activeStreams = this.#activeStreams.get(record.id) ?? 0;
        if (activeStreams >= this.#options.maxExecutionSubscribers) {
          controller.error(
            runtimeError(
              "EEXEC_BUSY",
              `execution ${record.id} has too many active event subscribers`,
            ),
          );
          return;
        }
        this.#activeStreams.set(record.id, activeStreams + 1);
        if (record.status === "running") record.subscribers.add(subscriber);
      },
      pull: () => this.#pump(record, subscriber),
      cancel: () => {
        record.subscribers.delete(subscriber);
        subscriber.release();
      },
    });
  }

  #append(record: ExecutionRecord, event: WorkspaceRuntimeEvent) {
    this.#persistEvent(record.id, event);
    this.#publishEvent(record, event);
  }

  #finish(
    record: ExecutionRecord,
    status: Exclude<ExecutionRecord["status"], "running">,
    events: WorkspaceRuntimeEvent[],
  ) {
    record.persistenceFailed = false;
    let settledStatus = status;
    let settledEvents = events;
    try {
      this.#host.db.transactionSync(() => {
        this.#host.db.run(
          `UPDATE workspace_runtime_executions
           SET status = ?, finished_at = ?
           WHERE backend = ? AND id = ?`,
          status,
          Date.now(),
          this.#backendId,
          record.id,
        );
        for (const event of events) this.#persistEvent(record.id, event);
        clearResume(this.#host.db, this.#backendId, record.id);
      });
    } catch {
      // The execution must settle even if durable storage is unavailable.
      // Keep its terminal record for same-session replay; reconnect repairs
      // the remaining durable `running` row.
      record.persistenceFailed = true;
      settledStatus = "failed";
      settledEvents = [
        {
          id: record.id,
          seq: record.events.length + 1,
          name: "stderr",
          value: new TextEncoder().encode(
            "Execution failed because its terminal state could not be persisted.\n",
          ),
        },
        { id: record.id, seq: record.events.length + 2, name: "exit", code: 1 },
      ];
    }
    record.status = settledStatus;
    record.events.push(...settledEvents);
    this.#markSettled(record.id);
    for (const subscriber of [...record.subscribers]) this.#pump(record, subscriber);
    this.#close(record);
    if (!record.persistenceFailed) {
      try {
        this.#prune();
      } catch {
        // Retention cleanup is retried on the next operation.
      }
    }
  }

  #persistEvent(executionId: string, event: WorkspaceRuntimeEvent) {
    this.#host.db.run(
      `INSERT INTO workspace_runtime_events (backend, execution_id, seq, name, payload)
       VALUES (?, ?, ?, ?, ?)`,
      this.#backendId,
      executionId,
      event.seq,
      event.name,
      encodeEvent(event),
    );
  }

  #publishEvent(record: ExecutionRecord, event: WorkspaceRuntimeEvent) {
    record.events.push(event);
    for (const subscriber of [...record.subscribers]) this.#pump(record, subscriber);
  }

  #pump(record: ExecutionRecord, subscriber: ExecutionSubscriber) {
    try {
      while (
        subscriber.index < record.events.length &&
        (subscriber.controller.desiredSize ?? 0) > 0
      ) {
        subscriber.controller.enqueue(record.events[subscriber.index++]);
      }
      if (subscriber.index >= record.events.length && record.status !== "running") {
        record.subscribers.delete(subscriber);
        subscriber.release();
        subscriber.controller.close();
      }
    } catch {
      record.subscribers.delete(subscriber);
      subscriber.release();
    }
  }

  #close(record: ExecutionRecord) {
    for (const subscriber of [...record.subscribers]) this.#pump(record, subscriber);
    record.control = undefined;
    record.bridge = undefined;
    if (record.status !== "running" && !record.persistenceFailed) {
      this.#records.delete(record.id);
    }
    while (this.#records.size > this.#options.maxRetainedExecutions) {
      const completed = [...this.#records.values()].find((item) => item.status !== "running");
      if (!completed) break;
      this.#records.delete(completed.id);
    }
  }

  #prune() {
    const cutoff = Date.now() - this.#options.retentionMs;
    this.#host.db.transactionSync(() => {
      this.#host.db.run(
        `DELETE FROM workspace_runtime_events
         WHERE backend = ? AND execution_id IN (
           SELECT id FROM workspace_runtime_executions
           WHERE backend = ? AND status != 'running' AND finished_at < ?
         )`,
        this.#backendId,
        this.#backendId,
        cutoff,
      );
      this.#host.db.run(
        `DELETE FROM workspace_runtime_executions
         WHERE backend = ? AND status != 'running' AND finished_at < ?`,
        this.#backendId,
        cutoff,
      );
      // Saved start data and journals belong to running executions only.
      // Anything else was left by a terminal state that wasn't persisted.
      for (const table of RESUME_TABLES) {
        this.#host.db.run(
          `DELETE FROM ${table}
           WHERE backend = ? AND execution_id NOT IN (
             SELECT id FROM workspace_runtime_executions WHERE backend = ? AND status = 'running'
           )`,
          this.#backendId,
          this.#backendId,
        );
      }
      const excess = this.#host.db.all<{ id: string }>(
        `SELECT id FROM workspace_runtime_executions
         WHERE backend = ? AND status != 'running'
         ORDER BY finished_at DESC, created_at DESC, rowid DESC
         LIMIT -1 OFFSET ?`,
        this.#backendId,
        this.#options.maxRetainedExecutions,
      );
      for (const { id } of excess) {
        this.#host.db.run(
          `DELETE FROM workspace_runtime_events WHERE backend = ? AND execution_id = ?`,
          this.#backendId,
          id,
        );
        this.#host.db.run(
          `DELETE FROM workspace_runtime_executions WHERE backend = ? AND id = ?`,
          this.#backendId,
          id,
        );
      }
    });
  }
}

// Whether pending work keeps this Durable Object in memory, which the host
// Worker's compatibility date decides: from 2026-10-01 it does, before it
// doesn't, and a keep-alive timer would do nothing. The Dynamic Worker's
// own compatibility date plays no part. Outside the Workers runtime the
// flags aren't there to read, and the timer is scheduled, which is
// harmless.
function hostKeepsPendingWork(): boolean {
  const flags = (
    globalThis as { Cloudflare?: { compatibilityFlags?: Record<string, boolean | undefined> } }
  ).Cloudflare?.compatibilityFlags;
  return flags?.durable_object_io_tasks_prevent_eviction ?? true;
}

function encodeEvent(event: WorkspaceRuntimeEvent): Uint8Array {
  if (event.name === "stdout" || event.name === "stderr") return event.value;
  const payload =
    "result" in event ? { code: event.code, result: event.result } : { code: event.code };
  return new TextEncoder().encode(JSON.stringify(payload));
}

function decodeEvent(
  id: string,
  seq: number,
  name: WorkspaceRuntimeEvent["name"],
  payload: Uint8Array,
): WorkspaceRuntimeEvent {
  if (name === "stdout" || name === "stderr") return { id, seq, name, value: payload };
  const decoded = JSON.parse(new TextDecoder().decode(payload)) as unknown;
  if (typeof decoded === "object" && decoded !== null && "code" in decoded) {
    const record = decoded as { code: unknown; result?: unknown };
    if ("result" in record) {
      assertRuntimeValue(record.result);
      return { id, seq, name: "exit", code: Number(record.code), result: record.result };
    }
    return { id, seq, name: "exit", code: Number(record.code) };
  }
  return { id, seq, name: "exit", code: Number(decoded) };
}

function startJavaScriptExecution(options: {
  loader: WorkspaceRuntimeLoader;
  modules: Record<string, string | { js?: string }>;
  entryName: string;
  input: WorkspaceRuntimeValue;
  context: WorkspaceExecutionContext;
  bridge: WorkspaceRuntimeBridge;
  timeoutMs: number;
  cpuMs: number;
  egress: WorkspaceEgressPolicy;
  compatibilityDate: string;
  compatibilityFlags: string[];
  maxStdioBytes: number;
  maxSourceBytes: number;
  onComplete(): void | Promise<void>;
  onError(message: string): void | Promise<void>;
}): ActiveControl {
  const modules = {
    ...options.modules,
    "workspace-runtime-runner.js": runtimeWorkerModule(options.entryName, options.maxStdioBytes),
  };
  assertLoaderGraph(modules, options.maxSourceBytes);
  const worker = options.loader.load({
    compatibilityDate: options.compatibilityDate,
    compatibilityFlags: options.compatibilityFlags,
    limits: { cpuMs: options.cpuMs },
    mainModule: "workspace-runtime-runner.js",
    modules,
    ...dynamicWorkerEgress(options.egress),
  });
  let entrypoint: JavaScriptEntrypoint;
  try {
    entrypoint = worker.getEntrypoint(undefined, {
      limits: { cpuMs: options.cpuMs },
    }) as JavaScriptEntrypoint;
  } catch (error) {
    disposeQuietly(worker as { [Symbol.dispose]?: () => void });
    throw error;
  }
  let cancelled = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposeQuietly(entrypoint);
    disposeQuietly(worker as { [Symbol.dispose]?: () => void });
  };
  let cancelExecution!: (error: Error) => void;
  const cancellation = new Promise<never>((_, reject) => {
    cancelExecution = reject;
  });
  // evaluate stays in flight for the whole run: it pushes its framed
  // output stream to the host through the bridge (drained live there)
  // and resolves only once user code returns and the stream closes.
  const run = Promise.resolve().then(() =>
    entrypoint.evaluate(options.input, options.bridge, options.context),
  );
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("JavaScript execution timed out")),
      options.timeoutMs,
    );
  });
  const completion = Promise.race([run, timeout, cancellation])
    .then(async () => {
      if (timer !== undefined) clearTimeout(timer);
      dispose();
      await options.onComplete();
    })
    .catch(async (error) => {
      if (timer !== undefined) clearTimeout(timer);
      dispose();
      if (!cancelled) {
        await options.onError(
          String(error).includes("hung and would never generate a response")
            ? "JavaScript execution timed out"
            : error instanceof Error
              ? error.message
              : String(error),
        );
      }
    })
    .finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      dispose();
    });
  // The stream read can reject after a timeout or cancel already
  // settled the race; swallow that late rejection.
  run.catch(() => undefined);
  return {
    completion,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      cancelExecution(new Error("JavaScript execution cancelled"));
      dispose();
    },
  };
}

/**
 * The code the runtime loads into the isolate besides the run's own, for
 * the test that asks whether REPLAY_VERSION needs a bump.
 */
export function runtimeCode(entryName: string, maxStdioBytes: number, maxCapabilityBytes: number) {
  return [
    runtimeWorkerModule(entryName, maxStdioBytes),
    ...internalModuleSources(maxCapabilityBytes),
  ];
}

function runtimeWorkerModule(entryName: string, maxStdioBytes: number) {
  return `
    import { WorkerEntrypoint } from "cloudflare:workers";
    import { call, install, moduleScopeRefusals } from "workspace-capabilities.js";
    import { install as installDurable, takeLog } from "workspace-durable.js";

    // A promise nobody awaits would otherwise fail without a trace while
    // the run reports success. Track the rejections nothing handled, and
    // fail the run if any are left once it is done. The runtime doesn't
    // report rejections from module evaluation this way, which is why
    // capability calls refused at module scope are tracked separately.
    const unhandled = new Map();
    addEventListener("unhandledrejection", (event) => {
      unhandled.set(event.promise, event.reason);
      event.preventDefault();
    });
    addEventListener("rejectionhandled", (event) => unhandled.delete(event.promise));

    export default class extends WorkerEntrypoint {
      async evaluate(input, host, context) {
        const env = (context && context.env) || {};
        const cwd = (context && context.cwd) || "/workspace";
        const stdinBytes = (context && context.stdin) || new Uint8Array(0);
        const stdin = {
          isTTY: false,
          [Symbol.asyncIterator]() {
            let done = false;
            return {
              next() {
                if (done) return Promise.resolve({ done: true, value: undefined });
                done = true;
                if (stdinBytes.byteLength === 0) {
                  return Promise.resolve({ done: true, value: undefined });
                }
                return Promise.resolve({ done: false, value: stdinBytes });
              },
            };
          },
        };
        const nextProcess = {
          env,
          argv: ["workspace", ${JSON.stringify(entryName)}],
          cwd: () => cwd,
          platform: "linux",
          stdin,
        };
        try {
          globalThis.process = nextProcess;
        } catch {}
        if (globalThis.process !== nextProcess) {
          try {
            Object.defineProperty(globalThis, "process", {
              value: nextProcess,
              configurable: true,
              writable: true,
            });
          } catch {}
        }
        if (globalThis.process !== nextProcess && globalThis.process) {
          try {
            globalThis.process.env = env;
          } catch {}
          try {
            globalThis.process.stdin = stdin;
          } catch {}
        }
        const encoder = new TextEncoder();
        const output = new IdentityTransformStream();
        const writer = output.writable.getWriter();
        const toBase64 = (text) => {
          const bytes = encoder.encode(text);
          let binary = "";
          for (let index = 0; index < bytes.length; index += 1) {
            binary += String.fromCharCode(bytes[index]);
          }
          return btoa(binary);
        };
        // Serialize writes on a chain so a rejected write (the host
        // cancelled or the stream errored) is caught here rather than
        // surfacing as an unhandled rejection inside the isolate. The
        // task awaits writeChain before closing.
        let writeChain = Promise.resolve();
        const enqueue = (frame) => {
          const log = takeLog();
          if (log !== undefined) frame.log = log;
          const bytes = encoder.encode(JSON.stringify(frame) + "\\n");
          writeChain = writeChain.then(() => writer.write(bytes)).catch(() => {});
        };
        let stdioBytes = 0;
        let stdioTruncated = false;
        const record = (stream, text) => {
          if (stdioTruncated) return;
          const bytes = encoder.encode(text);
          const remaining = ${maxStdioBytes} - stdioBytes;
          if (bytes.byteLength <= remaining) {
            enqueue({ name: stream, b64: toBase64(text) });
            stdioBytes += bytes.byteLength;
            return;
          }
          const marker = encoder.encode("...[stdio truncated]");
          const available = remaining - marker.byteLength;
          if (available >= 0) {
            let head = bytes.slice(0, available);
            let partial = "";
            while (head.byteLength > 0) {
              try {
                partial = new TextDecoder("utf-8", { fatal: true }).decode(head);
                break;
              } catch {
                head = head.slice(0, -1);
              }
            }
            enqueue({ name: stream, b64: toBase64(partial + "...[stdio truncated]") });
            stdioBytes += head.byteLength + marker.byteLength;
          }
          stdioTruncated = true;
        };
        const consoleLine = (stream, args) => record(stream, args.map(String).join(" ") + "\\n");
        console.log = (...args) => consoleLine("stdout", args);
        console.info = (...args) => consoleLine("stdout", args);
        console.warn = (...args) => consoleLine("stderr", args);
        console.error = (...args) => consoleLine("stderr", args);
        nextProcess.stdout = {
          write: (chunk) => {
            record("stdout", typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
            return true;
          },
        };
        nextProcess.stderr = {
          write: (chunk) => {
            record("stderr", typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
            return true;
          },
        };
        if (globalThis.process !== nextProcess && globalThis.process) {
          try {
            globalThis.process.stdout = nextProcess.stdout;
          } catch {}
          try {
            globalThis.process.stderr = nextProcess.stderr;
          } catch {}
        }
        const truncate = (message) => {
          const bytes = encoder.encode(message);
          let prefix = bytes.slice(0, ${maxStdioBytes - 1});
          while (prefix.byteLength > 0) {
            try {
              return new TextDecoder("utf-8", { fatal: true }).decode(prefix);
            } catch {
              prefix = prefix.slice(0, -1);
            }
          }
          return "";
        };
        install(host);
        // A replayable run gets a clock, timers, random numbers and fetch
        // that replay the way they went the first time.
        // The runner keeps the real timer for itself.
        const realSetTimeout = globalThis.setTimeout;
        if (context && context.durable) installDurable(context.durable, host, call);
        // Hand the readable end to the host, which drains it live while
        // this call stays in flight. Keeping evaluate in flight is what
        // holds the host bridge stub alive for the whole run; frames
        // enqueue as output is produced.
        const drained = host.attachOutput(output.readable);
        unhandled.clear();
        try {
          const module = await import(${JSON.stringify(entryName)});
          const result = typeof module.default === "function"
            ? await module.default(input)
            : module.default ?? null;
          // Rejections are reported after the microtask queue drains.
          await new Promise((resolve) => realSetTimeout(resolve, 0));
          if (moduleScopeRefusals.length > 0) throw moduleScopeRefusals[0];
          for (const reason of unhandled.values()) {
            const message = reason instanceof Error ? reason.message : String(reason);
            throw new Error("Unhandled rejection: " + message);
          }
          const value = result ?? null;
          await host.assertResult(value);
          enqueue({ name: "exit", code: 0, result: value });
        } catch (error) {
          // Imports of configured and host modules were rewritten to paths
          // into the module directory. Name them as the code wrote them.
          const message = (error instanceof Error ? error.message : String(error))
            .replace(/(?:file:\\/\\/\\/bundle\\/|(?:\\.\\.?\\/)+)__modules__\\//g, "");
          enqueue({ name: "stderr", b64: toBase64(truncate(message) + "\\n") });
          enqueue({ name: "exit", code: 1 });
        }
        await writeChain;
        try {
          await writer.close();
        } catch {}
        await drained;
      }
    }
  `;
}

// A new Workspace has no directories, not even the root that code reads
// and writes by default. Create it the first time it's needed. A
// recursive mkdir records a change even when the directory exists, so
// look first rather than calling it on every run.
async function ensureDirectory(fs: WorkspaceBackendHost["fs"], path: string): Promise<void> {
  try {
    await fs.stat(path);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    await fs.mkdir(path, { recursive: true });
  }
}

function assertLoaderGraph(
  modules: Record<string, string | { js?: string }>,
  maxSourceBytes: number,
) {
  const entries = Object.values(modules);
  if (entries.length > 256) {
    throw new Error("Workspace JavaScript loader graph exceeds 256 modules.");
  }
  const bytes = entries.reduce(
    (total, value) =>
      total +
      new TextEncoder().encode(typeof value === "string" ? value : (value.js ?? "")).byteLength,
    0,
  );
  if (bytes > maxSourceBytes) {
    throw new Error(`Workspace JavaScript loader graph exceeds ${maxSourceBytes} source bytes.`);
  }
}

function truncateUtf8(value: string, maxBytes: number) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let prefix = bytes.slice(0, maxBytes);
  while (prefix.byteLength > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(prefix);
    } catch {
      prefix = prefix.slice(0, -1);
    }
  }
  return "";
}

function assertEncodedSize(value: WorkspaceRuntimeValue, maxBytes: number, name: string) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > maxBytes) {
    throw new Error(`Workspace runtime ${name} exceeds ${maxBytes} bytes.`);
  }
}

function normalizeStdin(stdin: Uint8Array | string | undefined): Uint8Array {
  if (stdin === undefined) return new Uint8Array(0);
  if (typeof stdin === "string") return new TextEncoder().encode(stdin);
  if (stdin instanceof Uint8Array) return stdin;
  throw new Error("Workspace runtime stdin must be a string or Uint8Array.");
}

function assertEnv(env: Record<string, string> | undefined, maxBytes: number): void {
  if (env === undefined) return;
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new Error("Workspace runtime env must be a string-to-string record.");
  }
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      throw new Error(`Workspace runtime env value for ${JSON.stringify(key)} must be a string.`);
    }
    bytes += encoder.encode(key).byteLength + encoder.encode(value).byteLength;
  }
  if (bytes > maxBytes) {
    throw new Error(`Workspace runtime env exceeds ${maxBytes} bytes.`);
  }
}

function assertPositiveFinite(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`WorkerJavaScriptBackend ${name} must be a positive finite number.`);
  }
}

function assertPositiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`WorkerJavaScriptBackend ${name} must be a positive integer.`);
  }
}

function assertInterruptPolicy(value: unknown): asserts value is WorkspaceRuntimeInterruptPolicy {
  if (!INTERRUPT_POLICIES.includes(value as WorkspaceRuntimeInterruptPolicy)) {
    throw new Error('onInterrupt must be "fail", "restart" or "replay".');
  }
}

function assertExecutionId(id: string) {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Workspace runtime execution id must be a non-empty string.");
  }
  if (new TextEncoder().encode(id).byteLength > 256) {
    throw new Error("Workspace runtime execution id exceeds 256 bytes.");
  }
}

function addColumnIfMissing(
  host: WorkspaceModuleBackendHost,
  table: string,
  column: string,
  declaration: string,
) {
  const columns = host.db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) {
    host.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

function runtimeError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function disposeQuietly(value: { [Symbol.dispose]?: () => void }) {
  try {
    value[Symbol.dispose]?.();
  } catch {}
}

function recordedOutput(
  events: readonly WorkspaceRuntimeEvent[],
  name: "stdout" | "stderr",
): Uint8Array {
  const chunks = events.flatMap((event) => (event.name === name ? [event.value] : []));
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
