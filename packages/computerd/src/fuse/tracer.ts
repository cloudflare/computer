// FUSE op tracer.
//
// Wraps each FUSE op so we can count calls, count errors, and measure
// per-op wall time. Output is JSON, dumped to stderr (or a file via
// `COMPUTERD_FUSE_TRACE_FILE`) on SIGUSR2 and on unmount, or whenever an
// operator calls `tracer.formatJson()`.
//
// The aggregator (`summarizeFuseTrace`) is pure so it can be unit
// tested without touching FUSE. The wrapper (`wrapFuseOpsWithTracer`)
// replaces every callback-bearing function on the ops object with one
// that times its callback. Marker symbol on each wrapped function
// makes double-wrapping a no-op so tests and accidental rewrapping
// stay cheap.

const WRAPPED = Symbol("computerd.fuseTracerWrapped");

export interface FuseOpStats {
  count: number;
  errors: number;
  /** Sum of all observed durations, in nanoseconds. Bigint to avoid float drift over long runs. */
  totalNs: bigint;
  /** Ring buffer of recent samples in nanoseconds, capped at `maxSamplesPerOp`. */
  samples: bigint[];
}

export interface FuseTracerSnapshotOp {
  op: string;
  count: number;
  errors: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  totalMs: number;
}

export interface FuseTracerSnapshot {
  ops: FuseTracerSnapshotOp[];
  totalCalls: number;
  totalErrors: number;
}

export interface FuseTracer {
  /** Wrap a single FUSE op. Tests reach for this directly; production code uses wrapFuseOpsWithTracer. */
  wrap<F extends (...args: never[]) => void>(op: string, fn: F): F;
  /** Raw stats keyed by op name. The returned object is a defensive snapshot. */
  snapshot(): Record<string, FuseOpStats>;
  /** JSON summary suitable for stderr or `COMPUTERD_FUSE_TRACE_FILE`. */
  formatJson(opts?: { pretty?: boolean }): string;
  /** Reset all counters; used by tests. */
  reset(): void;
}

export interface CreateFuseTracerOptions {
  /** Cap per-op sample retention so a 10M-call benchmark doesn't OOM. Default: 8192. */
  maxSamplesPerOp?: number;
}

/**
 * Build a fresh tracer. Each tracer owns its own stats table; nothing
 * is global so tests can spin one up per case without cross-talk.
 */
export function createFuseTracer(options: CreateFuseTracerOptions = {}): FuseTracer {
  const maxSamples = options.maxSamplesPerOp ?? 8192;
  const stats = new Map<string, FuseOpStats>();

  const statsFor = (op: string): FuseOpStats => {
    let entry = stats.get(op);
    if (entry === undefined) {
      entry = { count: 0, errors: 0, totalNs: 0n, samples: [] };
      stats.set(op, entry);
    }
    return entry;
  };

  const record = (op: string, durationNs: bigint, isError: boolean): void => {
    const entry = statsFor(op);
    entry.count++;
    if (isError) entry.errors++;
    entry.totalNs += durationNs;
    if (entry.samples.length >= maxSamples) {
      // Cheap eviction: drop the oldest sample. We don't need true
      // reservoir sampling — the bench runs are short enough that
      // a sliding window of recent samples gives representative
      // percentiles, and shift on a bounded buffer is fine here.
      entry.samples.shift();
    }
    entry.samples.push(durationNs);
  };

  const tracer: FuseTracer = {
    wrap<F extends (...args: never[]) => void>(op: string, fn: F): F {
      const marker = fn as unknown as { [WRAPPED]?: boolean };
      if (marker[WRAPPED] === true) return fn;
      const wrapped = ((...args: unknown[]) => {
        const lastIdx = args.length - 1;
        const cb = args[lastIdx];
        if (typeof cb !== "function") {
          // No callback to time — call through and skip recording.
          (fn as unknown as (...a: unknown[]) => void)(...args);
          return;
        }
        const start = process.hrtime.bigint();
        args[lastIdx] = (firstArg: unknown, ...rest: unknown[]) => {
          const elapsed = process.hrtime.bigint() - start;
          // FUSE convention: a negative status is errno, zero/positive
          // is success (bytes read/written, fd, …). Anything that isn't
          // a number we can't classify, so treat it as success.
          const isError = typeof firstArg === "number" && firstArg < 0;
          record(op, elapsed, isError);
          (cb as (...a: unknown[]) => void)(firstArg, ...rest);
        };
        (fn as unknown as (...a: unknown[]) => void)(...args);
      }) as unknown as F;
      (wrapped as unknown as { [WRAPPED]?: boolean })[WRAPPED] = true;
      return wrapped;
    },
    snapshot() {
      const out: Record<string, FuseOpStats> = {};
      for (const [op, entry] of stats) {
        out[op] = {
          count: entry.count,
          errors: entry.errors,
          totalNs: entry.totalNs,
          samples: entry.samples.slice(),
        };
      }
      return out;
    },
    formatJson(opts = {}) {
      const summary = summarizeFuseTrace(this.snapshot());
      return opts.pretty === false ? JSON.stringify(summary) : JSON.stringify(summary, null, 2);
    },
    reset() {
      stats.clear();
    },
  };
  return tracer;
}

/**
 * Pure aggregator: takes raw stats keyed by op and produces a sortable,
 * JSON-friendly summary with mean and percentile timings in
 * milliseconds. Exported so tests can pin its arithmetic without
 * exercising the wrapping path.
 */
export function summarizeFuseTrace(stats: Record<string, FuseOpStats>): FuseTracerSnapshot {
  const ops: FuseTracerSnapshotOp[] = [];
  let totalCalls = 0;
  let totalErrors = 0;
  for (const [op, entry] of Object.entries(stats)) {
    totalCalls += entry.count;
    totalErrors += entry.errors;
    const totalMs = Number(entry.totalNs) / 1_000_000;
    const avgMs = entry.count === 0 ? 0 : totalMs / entry.count;
    const sorted = entry.samples.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    ops.push({
      op,
      count: entry.count,
      errors: entry.errors,
      avgMs,
      p50Ms: percentileMs(sorted, 0.5),
      p95Ms: percentileMs(sorted, 0.95),
      p99Ms: percentileMs(sorted, 0.99),
      maxMs: sorted.length === 0 ? 0 : Number(sorted[sorted.length - 1]) / 1_000_000,
      totalMs,
    });
  }
  ops.sort((a, b) => b.totalMs - a.totalMs);
  return { ops, totalCalls, totalErrors };
}

function percentileMs(sortedSamples: bigint[], q: number): number {
  if (sortedSamples.length === 0) return 0;
  // Nearest-rank: lower bound 1, so q=0 still picks index 0.
  const rank = Math.max(1, Math.ceil(q * sortedSamples.length));
  return Number(sortedSamples[rank - 1]) / 1_000_000;
}

/**
 * Wrap every callback-bearing op on a FUSE ops object so the tracer
 * records timings without the driver having to know it's being
 * traced. Non-function fields pass through untouched; already-wrapped
 * functions short-circuit, so wrapping twice is a no-op.
 */
export function wrapFuseOpsWithTracer<T extends Record<string, unknown>>(
  ops: T,
  tracer: FuseTracer,
): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(ops)) {
    if (typeof value === "function") {
      out[name] = tracer.wrap(name, value as never);
    } else {
      out[name] = value;
    }
  }
  return out as T;
}
