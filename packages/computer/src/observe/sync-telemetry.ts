// Structured sync telemetry for Workers Logs.
//
// The observer hook in `../observe.ts` emits spans, which is the right
// shape for tracing and nesting. It is not the shape the Workers
// Observability query API can aggregate today: that API queries the
// Workers Logs dataset, where a single JSON argument to `console.log`
// becomes a set of filterable `$workers.event.*` fields.
//
// So this module exists alongside the span hook rather than replacing
// it. Spans answer "what happened inside this request"; these records
// answer "what did every sync block in production cost", which is the
// question the benchmark harnesses can only answer for a dev container.
//
// Field design follows two constraints of that query API:
//
//   * Every value is a scalar at the top level. A filter addresses
//     `$workers.event.<key>`, so a nested object turns every query into
//     an indexed-path lookup that breaks when shapes change.
//   * Derived values are precomputed. The API aggregates a single
//     numeric field per calculation, so a ratio a query would otherwise
//     have to compute across two fields is computed here instead.
//
// Example queries once a session has run, using the telemetry tool:
//
//   Worst block CPU, by mode:
//     filters:      $workers.event.event = "sync.block"
//     calculations: max($workers.event.blockMs)
//     groupBys:     $workers.event.mode
//
//   Any block that came close to the CPU limit:
//     filters:      $workers.event.event = "sync.block"
//                   $workers.event.headroom < 3
//
//   Effective transport throughput, which decides whether packs win:
//     filters:      $workers.event.event = "sync.operation"
//     calculations: p50($workers.event.bytesPerSecond)
//                   p95($workers.event.bytesPerSecond)
//     groupBys:     $workers.event.mode

/** Default Durable Object active-CPU allowance, in milliseconds. */
export const DEFAULT_CPU_LIMIT_MS = 30_000;

export interface SyncBlockTelemetry {
  readonly backend: string;
  readonly direction: "pull" | "push";
  readonly mode: "entries" | "pack";
  readonly operationId: string;
  readonly generation: string;
  readonly entries: number;
  readonly bytes: number;
  readonly skipped: number;
  readonly complete: boolean;
  /** Wall time for this block, which for a sync block tracks CPU closely. */
  readonly blockMs: number;
  readonly cursorRev: number;
  readonly targetRev: number;
  readonly cpuLimitMs?: number;
}

export interface SyncOperationTelemetry {
  readonly backend: string;
  readonly direction: "pull" | "push";
  readonly mode: "entries" | "pack";
  readonly operationId: string;
  readonly generation: string;
  readonly blocks: number;
  readonly entries: number;
  readonly bytes: number;
  readonly skipped: number;
  readonly totalMs: number;
  readonly worstBlockMs: number;
  /** How many blocks ran from a recreated iterable rather than a reused one. */
  readonly restarts: number;
}

export type TelemetryRecord = Record<string, string | number | boolean | undefined>;

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Build the flat record for one committed block.
 *
 * `headroom` is the ratio of the CPU allowance to what this block
 * actually spent, so `min(headroom)` over a session is the direct
 * answer to whether block sizing is safe in production. It is omitted
 * for a zero-duration block, where the ratio is meaningless rather than
 * infinite.
 */
export function syncBlockLog(input: SyncBlockTelemetry): TelemetryRecord {
  const cpuLimitMs = input.cpuLimitMs ?? DEFAULT_CPU_LIMIT_MS;
  const record: TelemetryRecord = {
    event: "sync.block",
    backend: input.backend,
    direction: input.direction,
    mode: input.mode,
    operationId: input.operationId,
    generation: input.generation,
    entries: input.entries,
    bytes: input.bytes,
    skipped: input.skipped,
    complete: input.complete,
    blockMs: round(input.blockMs, 1),
    cursorRev: input.cursorRev,
    targetRev: input.targetRev,
    // Convergence lag. A sync whose blocks never close this gap is the
    // failure most worth alerting on.
    revsBehind: Math.max(0, input.targetRev - input.cursorRev),
    cpuLimitMs,
    overBudget: input.blockMs > cpuLimitMs,
  };
  if (input.blockMs > 0) {
    record.headroom = round(cpuLimitMs / input.blockMs, 2);
  }
  if (input.entries > 0) {
    record.msPerEntry = round(input.blockMs / input.entries, 3);
  }
  if (input.bytes > 0 && input.blockMs > 0) {
    record.bytesPerSecond = Math.round(input.bytes / (input.blockMs / 1000));
  }
  return record;
}

/**
 * Build the flat record for a completed operation.
 *
 * `bytesPerSecond` here is the field that closes the open question
 * behind the pack thresholds. The benchmarks could only price the
 * bytes/CPU trade against hypothetical link speeds; this measures what
 * the real hop achieves.
 */
export function syncOperationLog(input: SyncOperationTelemetry): TelemetryRecord {
  const record: TelemetryRecord = {
    event: "sync.operation",
    backend: input.backend,
    direction: input.direction,
    mode: input.mode,
    operationId: input.operationId,
    generation: input.generation,
    blocks: input.blocks,
    entries: input.entries,
    bytes: input.bytes,
    skipped: input.skipped,
    totalMs: round(input.totalMs, 1),
    worstBlockMs: round(input.worstBlockMs, 1),
    restarts: input.restarts,
  };
  if (input.totalMs > 0) {
    record.bytesPerSecond = Math.round(input.bytes / (input.totalMs / 1000));
    record.entriesPerSecond = round(input.entries / (input.totalMs / 1000), 1);
  }
  if (input.entries > 0) {
    record.msPerEntry = round(input.totalMs / input.entries, 3);
  }
  if (input.blocks > 0) {
    record.msPerBlock = round(input.totalMs / input.blocks, 1);
  }
  return record;
}

export interface SyncLoggerOptions {
  /**
   * Set false to silence emission. Present so a caller can keep the
   * wiring in place and turn the volume off, rather than branching at
   * every call site.
   */
  readonly enabled?: boolean;
  /** Sink for one serialized record. Defaults to console.log. */
  readonly log?: (line: string) => void;
}

export interface SyncLogger {
  block(input: SyncBlockTelemetry): void;
  operation(input: SyncOperationTelemetry): void;
}

/**
 * Emit sync telemetry as single-line JSON.
 *
 * A throwing sink is swallowed. Telemetry exists to observe sync, and
 * an observability failure must not be able to fail the sync it is
 * watching.
 */
export function createSyncLogger(options: SyncLoggerOptions = {}): SyncLogger {
  const enabled = options.enabled ?? true;
  const sink = options.log ?? ((line: string) => console.log(line));
  const emit = (record: TelemetryRecord): void => {
    if (!enabled) return;
    try {
      sink(JSON.stringify(record));
    } catch {
      // Deliberately ignored; see the note above.
    }
  };
  return {
    block: (input) => emit(syncBlockLog(input)),
    operation: (input) => emit(syncOperationLog(input)),
  };
}
