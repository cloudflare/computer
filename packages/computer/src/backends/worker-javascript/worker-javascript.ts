import { WorkspaceRuntimeBridge } from "../../runtime/bridge.js";
import { assertRuntimeValue, WorkspaceRuntimeCapability } from "../../runtime/capability.js";
import { dynamicWorkerEgress, type WorkspaceEgressPolicy } from "../../runtime/egress.js";
import type {
  ModuleExecutionEnvelope,
  ModuleExecutionInput,
  WorkspaceModuleBackend,
  WorkspaceModuleBackendHandle,
  WorkspaceModuleBackendHost,
  WorkspaceRuntimeAccess,
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeLoader,
  WorkspaceRuntimeValue,
  WorkspaceTrustedModule,
} from "../../runtime/types.js";
import { decodeRuntimeFrames, type RuntimeFrame } from "./frames.js";
import { buildModuleGraph } from "./module-graph.js";

export interface WorkerJavaScriptBackendOptions {
  loader: WorkspaceRuntimeLoader;
  id?: string;
  root?: string;
  access?: WorkspaceRuntimeAccess;
  modules?: Record<string, string>;
  /**
   * Host-owned capability modules installed under reserved ws:* specifiers.
   * Caller source may import them, but cannot provide or replace them.
   */
  trustedModules?: Record<`ws:${string}`, WorkspaceTrustedModule>;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
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
  /** Maximum graph loads and Dynamic Workers active at once. Defaults to 1. */
  maxConcurrentExecutions?: number;
  /** Maximum live replay subscribers per execution. Defaults to 8. */
  maxExecutionSubscribers?: number;
  /** Completed execution retention window. Defaults to five minutes. */
  retentionMs?: number;
  /** Maximum completed executions retained per backend. Defaults to 100. */
  maxRetainedExecutions?: number;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  egress?: WorkspaceEgressPolicy;
  globalOutbound?: Fetcher | null;
  /** Allow ws:git operations that can perform host-side network requests. */
  allowGitNetwork?: boolean;
  /** Allow ws:artifacts imports from caller-selected remote URLs. */
  allowArtifactNetwork?: boolean;
}

type ResolvedWorkerJavaScriptBackendOptions = Required<
  Pick<
    WorkerJavaScriptBackendOptions,
    | "root"
    | "access"
    | "defaultTimeoutMs"
    | "maxTimeoutMs"
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
    | "maxConcurrentExecutions"
    | "maxExecutionSubscribers"
    | "retentionMs"
    | "maxRetainedExecutions"
    | "compatibilityDate"
    | "compatibilityFlags"
  >
> &
  Omit<WorkerJavaScriptBackendOptions, "egress" | "globalOutbound"> & {
    egress: WorkspaceEgressPolicy;
  };

interface WorkspaceExecutionContext {
  env: Record<string, string>;
  cwd: string;
  stdin: Uint8Array;
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
  admitted?: boolean;
  persistenceFailed?: boolean;
  result?: WorkspaceRuntimeValue;
  hasResult?: boolean;
  exitCode?: number;
}

export class WorkerJavaScriptBackend implements WorkspaceModuleBackend {
  readonly protocol = "module" as const;
  readonly type = "worker-javascript";
  readonly callable = true;
  readonly id: string;
  readonly #options: ResolvedWorkerJavaScriptBackendOptions;

  constructor(options: WorkerJavaScriptBackendOptions) {
    this.id = options.id ?? "worker-javascript";
    if (options.egress !== undefined && options.globalOutbound !== undefined) {
      throw new Error("WorkerJavaScriptBackend cannot use globalOutbound together with egress.");
    }
    const maxTimeoutMs = options.maxTimeoutMs ?? 180_000;
    const defaultTimeoutMs = options.defaultTimeoutMs ?? Math.min(60_000, maxTimeoutMs);
    assertPositiveFinite(maxTimeoutMs, "maxTimeoutMs");
    assertPositiveFinite(defaultTimeoutMs, "defaultTimeoutMs");
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
    assertPositiveInteger(options.maxConcurrentExecutions ?? 24, "maxConcurrentExecutions");
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
      root: options.root ?? "/workspace",
      access: options.access ?? "read-write",
      defaultTimeoutMs,
      maxTimeoutMs,
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
      maxConcurrentExecutions: options.maxConcurrentExecutions ?? 24,
      maxExecutionSubscribers: options.maxExecutionSubscribers ?? 8,
      retentionMs: options.retentionMs ?? 60 * 60_000,
      maxRetainedExecutions: options.maxRetainedExecutions ?? 100,
      compatibilityDate,
      compatibilityFlags: options.compatibilityFlags ?? ["nodejs_compat"],
    };
  }

  async connect(host: WorkspaceModuleBackendHost): Promise<WorkspaceModuleBackendHandle> {
    return new JavaScriptBackendHandle(this.#options, host);
  }
}

class JavaScriptBackendHandle implements WorkspaceModuleBackendHandle {
  readonly #options: ResolvedWorkerJavaScriptBackendOptions;
  readonly #host: WorkspaceModuleBackendHost;
  readonly #records = new Map<string, ExecutionRecord>();
  readonly #pendingIds = new Set<string>();
  #closed = false;
  #activeExecutions = 0;
  readonly #activeStreams = new Map<string, number>();
  #pendingStarts = 0;
  readonly #pendingStartWaiters = new Set<() => void>();

  constructor(options: ResolvedWorkerJavaScriptBackendOptions, host: WorkspaceModuleBackendHost) {
    this.#options = options;
    this.#host = host;
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
    this.#prune();
    const interrupted = host.db.all<{ id: string }>(
      `SELECT id FROM workspace_runtime_executions WHERE backend = ? AND status = 'running'`,
      this.#backendId,
    );
    for (const { id } of interrupted) {
      const record = this.#recordFor(id);
      if (record?.status !== "running") continue;
      this.#finish(record, "failed", [
        {
          id,
          seq: record.events.length + 1,
          name: "stderr",
          value: new TextEncoder().encode(
            "Execution was interrupted when its Workspace runtime restarted.\n",
          ),
        },
        { id, seq: record.events.length + 2, name: "exit", code: 1 },
      ]);
    }
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
    if (new TextEncoder().encode(input.source).byteLength > this.#options.maxSourceBytes) {
      throw new Error(`Workspace runtime source exceeds ${this.#options.maxSourceBytes} bytes.`);
    }
    if (this.#activeExecutions >= this.#options.maxConcurrentExecutions) {
      throw runtimeError(
        "EEXEC_BUSY",
        `JavaScript backend already has ${this.#activeExecutions} active execution(s)`,
      );
    }

    this.#activeExecutions += 1;
    this.#pendingStarts += 1;
    this.#pendingIds.add(id);
    let admittedRecord: ExecutionRecord | undefined;
    try {
      const capability = new WorkspaceRuntimeCapability(
        this.#host.fs,
        this.#options.root,
        this.#options.access,
        this.#options.maxCapabilityBytes,
        this.#options.maxDirectoryEntries,
      );
      const graph = await buildModuleGraph({
        source: input.source,
        cwd: input.cwd ?? this.#options.root,
        capability,
        configuredModules: this.#options.modules ?? {},
        trustedModuleNames: Object.keys(this.#options.trustedModules ?? {}),
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
        admitted: true,
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
      admittedRecord = record;
      this.#records.set(id, record);
      try {
        const bridge = new WorkspaceRuntimeBridge(capability, {
          git: this.#host.git,
          artifacts: this.#host.artifacts,
          trustedModules: this.#options.trustedModules,
          allowGitNetwork: this.#options.allowGitNetwork ?? false,
          allowArtifactNetwork: this.#options.allowArtifactNetwork ?? false,
          maxPayloadBytes: this.#options.maxCapabilityBytes,
          maxCallDurationMs: this.#options.maxHostCallMs,
          maxConcurrentCalls: this.#options.maxConcurrentCapabilityCalls,
          maxCalls: this.#options.maxCapabilityCalls,
          maxTotalRequestBytes: this.#options.maxCapabilityRequestBytes,
          maxTotalResponseBytes: this.#options.maxCapabilityResponseBytes,
          maxResultBytes: this.#options.maxResultBytes,
          onAttachOutput: (readable) => this.#pumpFrames(record, readable),
        });
        record.bridge = bridge;
        record.control = startJavaScriptExecution({
          loader: this.#options.loader,
          modules: graph.modules,
          entryName: graph.entryName,
          input: inputValue,
          context: {
            env: input.env ?? {},
            cwd: input.cwd ?? this.#options.root,
            stdin: stdinBytes,
          },
          bridge,
          timeoutMs,
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
      return { id, events: this.#stream(record) };
    } finally {
      this.#pendingIds.delete(id);
      this.#pendingStarts -= 1;
      if (this.#pendingStarts === 0) {
        for (const resolve of this.#pendingStartWaiters) resolve();
        this.#pendingStartWaiters.clear();
      }
      if (!admittedRecord) this.#activeExecutions -= 1;
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
        : record.finalization,
    );
    await Promise.allSettled(finalizations);
    for (const record of records) this.#close(record);
    this.#records.clear();
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
    const record: ExecutionRecord = {
      id,
      status: row.status,
      events,
      subscribers: new Set(),
    };
    if (record.status === "running") {
      // Every live execution is cached before its Dynamic Worker starts. A
      // durable running row without a cached record is therefore an orphan
      // left by restart or a failed terminal transaction.
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
    if (frame.name === "stdout" || frame.name === "stderr") {
      this.#append(record, {
        id: record.id,
        seq: record.events.length + 1,
        name: frame.name,
        value: frame.value,
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
    if (record.admitted) {
      record.admitted = false;
      this.#activeExecutions = Math.max(0, this.#activeExecutions - 1);
    }
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
    limits: { cpuMs: options.timeoutMs },
    mainModule: "workspace-runtime-runner.js",
    modules,
    ...dynamicWorkerEgress(options.egress),
  });
  let entrypoint: JavaScriptEntrypoint;
  try {
    entrypoint = worker.getEntrypoint(undefined, {
      limits: { cpuMs: options.timeoutMs },
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

function runtimeWorkerModule(entryName: string, maxStdioBytes: number) {
  return `
    import { WorkerEntrypoint } from "cloudflare:workers";
    import { install } from "workspace-capabilities.js";

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
        // Hand the readable end to the host, which drains it live while
        // this call stays in flight. Keeping evaluate in flight is what
        // holds the host bridge stub alive for the whole run; frames
        // enqueue as output is produced.
        const drained = host.attachOutput(output.readable);
        try {
          const module = await import(${JSON.stringify(entryName)});
          const result = typeof module.default === "function"
            ? await module.default(input)
            : module.default ?? null;
          const value = result ?? null;
          await host.assertResult(value);
          enqueue({ name: "exit", code: 0, result: value });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
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
