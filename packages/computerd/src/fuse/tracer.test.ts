import { describe, expect, test } from "vitest";

import {
  createFuseTracer,
  type FuseTracer,
  type FuseTracerSnapshot,
  summarizeFuseTrace,
  wrapFuseOpsWithTracer,
} from "./tracer.js";

describe("summarizeFuseTrace", () => {
  test("returns an empty summary when no ops have been recorded", () => {
    const summary = summarizeFuseTrace({});
    expect(summary).toEqual({ ops: [], totalCalls: 0, totalErrors: 0 });
  });

  test("computes count, error count, mean, p50, p95, p99 and max in ms", () => {
    // 100 samples: 1ns, 2ns, …, 100ns. Easy percentiles.
    const samples = Array.from({ length: 100 }, (_, i) => BigInt(i + 1));
    const summary = summarizeFuseTrace({
      getattr: {
        count: 100,
        errors: 3,
        totalNs: samples.reduce((a, b) => a + b, 0n),
        samples,
      },
    });

    expect(summary.totalCalls).toBe(100);
    expect(summary.totalErrors).toBe(3);
    expect(summary.ops).toHaveLength(1);
    const op = summary.ops[0];
    expect(op.op).toBe("getattr");
    expect(op.count).toBe(100);
    expect(op.errors).toBe(3);
    // Nearest-rank: p50 -> index ceil(0.5*100)-1 = 49 -> 50ns -> 50e-6 ms.
    expect(op.p50Ms).toBeCloseTo(50e-6, 12);
    expect(op.p95Ms).toBeCloseTo(95e-6, 12);
    expect(op.p99Ms).toBeCloseTo(99e-6, 12);
    expect(op.maxMs).toBeCloseTo(100e-6, 12);
    expect(op.avgMs).toBeCloseTo(50.5e-6, 12);
  });

  test("sorts ops by total time descending", () => {
    const summary = summarizeFuseTrace({
      cheap: { count: 10, errors: 0, totalNs: 100n, samples: [10n] },
      expensive: { count: 1, errors: 0, totalNs: 1_000_000n, samples: [1_000_000n] },
      medium: { count: 5, errors: 0, totalNs: 5000n, samples: [1000n] },
    });
    expect(summary.ops.map((o) => o.op)).toEqual(["expensive", "medium", "cheap"]);
  });
});

describe("createFuseTracer", () => {
  test("records duration and error count from a wrapped op", async () => {
    const tracer = createFuseTracer();
    let storedCb: ((errno: number) => void) | undefined;
    const op = (_path: string, cb: (errno: number) => void) => {
      storedCb = cb;
    };
    const wrapped = tracer.wrap("getattr", op as never) as typeof op;

    // Two successful calls and one error.
    await new Promise<void>((resolve) => {
      wrapped("/a", (_e) => resolve());
      storedCb?.(0);
    });
    await new Promise<void>((resolve) => {
      wrapped("/b", (_e) => resolve());
      storedCb?.(0);
    });
    await new Promise<void>((resolve) => {
      wrapped("/c", (_e) => resolve());
      storedCb?.(-2);
    });

    const snapshot = tracer.snapshot();
    expect(snapshot.getattr.count).toBe(3);
    expect(snapshot.getattr.errors).toBe(1);
    expect(snapshot.getattr.samples.length).toBe(3);
    expect(snapshot.getattr.totalNs > 0n).toBe(true);
  });

  test("treats positive return values from read/write as success", () => {
    const tracer = createFuseTracer();
    const op = (
      _path: string,
      _fh: number,
      _buf: Buffer,
      _len: number,
      _pos: number,
      cb: (n: number) => void,
    ) => cb(42); // 42 bytes read, not an error.
    const wrapped = tracer.wrap("read", op as never) as typeof op;
    wrapped("/a", 0, Buffer.alloc(0), 0, 0, () => {});
    const snap = tracer.snapshot();
    expect(snap.read.count).toBe(1);
    expect(snap.read.errors).toBe(0);
  });

  test("caps the per-op sample ring buffer", () => {
    const tracer = createFuseTracer({ maxSamplesPerOp: 4 });
    let storedCb: ((errno: number) => void) | undefined;
    const op = (cb: (errno: number) => void) => {
      storedCb = cb;
    };
    const wrapped = tracer.wrap("getattr", op as never) as typeof op;
    for (let i = 0; i < 10; i++) {
      wrapped(() => {});
      storedCb?.(0);
    }
    const snap = tracer.snapshot();
    expect(snap.getattr.count).toBe(10);
    expect(snap.getattr.samples.length).toBe(4);
  });

  test("formatJson returns parseable JSON shaped like a snapshot summary", () => {
    const tracer = createFuseTracer();
    let storedCb: ((errno: number) => void) | undefined;
    const op = (cb: (errno: number) => void) => {
      storedCb = cb;
    };
    const wrapped = tracer.wrap("flush", op as never) as typeof op;
    wrapped(() => {});
    storedCb?.(0);

    const json = tracer.formatJson();
    const parsed = JSON.parse(json) as FuseTracerSnapshot;
    expect(parsed.totalCalls).toBe(1);
    expect(parsed.ops[0].op).toBe("flush");
  });
});

describe("wrapFuseOpsWithTracer", () => {
  test("wraps every callback-bearing op without disturbing non-callback fields", () => {
    const tracer = createFuseTracer();
    const ops = {
      init: (cb: (errno: number) => void) => cb(0),
      getattr: (_p: string, cb: (errno: number, r: unknown) => void) => cb(0, null),
      notAnOp: 42,
    } as unknown as Parameters<typeof wrapFuseOpsWithTracer>[0];

    const wrapped = wrapFuseOpsWithTracer(ops, tracer) as typeof ops & {
      notAnOp: number;
    };

    expect(wrapped.notAnOp).toBe(42);
    (wrapped.init as (cb: (e: number) => void) => void)(() => {});
    (wrapped.getattr as (p: string, cb: (e: number, r: unknown) => void) => void)("/a", () => {});

    const snap = tracer.snapshot();
    expect(snap.init.count).toBe(1);
    expect(snap.getattr.count).toBe(1);
  });

  test("does not double-wrap when called twice on the same ops object", () => {
    const tracer = createFuseTracer();
    const ops = {
      getattr: (_p: string, cb: (errno: number, r: unknown) => void) => cb(0, null),
    } as unknown as Parameters<typeof wrapFuseOpsWithTracer>[0];

    const once = wrapFuseOpsWithTracer(ops, tracer);
    const twice = wrapFuseOpsWithTracer(once, tracer);
    (twice.getattr as (p: string, cb: (e: number, r: unknown) => void) => void)("/a", () => {});

    const snap = tracer.snapshot();
    expect(snap.getattr.count).toBe(1);
  });
});

// Compile-time check: the tracer type is exported and usable.
const _typeProbe: FuseTracer | null = null;
void _typeProbe;
