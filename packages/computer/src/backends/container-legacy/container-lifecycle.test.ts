import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  containerExitInfo,
  destroyContainerExpectingExit,
  formatExitReason,
  getContainerLifecycle,
  installContainerMonitor,
  resetContainerLifecycleForTests,
} from "./container-lifecycle.js";

// Minimal Container stand-in. The lifecycle module only touches
// .destroy(), .start(), .running, and .monitor(). A controllable
// per-generation monitor() promise lets the tests drive the exit
// signal deterministically and aim it at a specific generation.
//
// `current` exposes the live generation's controls; `generations`
// preserves the per-generation tuples so a test can fire the
// first generation's reject AFTER the second generation has been
// armed, simulating the platform's behavior when an old monitor's
// settle frame arrives late.
interface MonitorControls {
  resolve: () => void;
  reject: (error: unknown) => void;
  promise: Promise<void>;
}

function makeContainer(): {
  container: NonNullable<DurableObjectState["container"]>;
  starts: number;
  destroys: number;
  monitorCalls: number;
  current: MonitorControls;
  generations: MonitorControls[];
} {
  let starts = 0;
  let destroys = 0;
  let monitorCalls = 0;
  let running = false;
  const generations: MonitorControls[] = [];

  function armPromise(): MonitorControls {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Swallow unhandled rejection noise when the test path leaves
    // the promise pending or rejects without awaiting it.
    promise.catch(() => {});
    const controls: MonitorControls = { resolve, reject, promise };
    generations.push(controls);
    return controls;
  }
  let current = armPromise();

  const container = {
    get running() {
      return running;
    },
    start(_options?: unknown) {
      starts++;
      running = true;
      // Each start() arms a fresh monitor() that the next monitor()
      // call returns.
      current = armPromise();
    },
    async destroy() {
      destroys++;
      running = false;
      // The real container.monitor() rejects on destroy() (SIGKILL
      // surfaces as a non-zero exit). The fake mirrors that
      // contract so the lifecycle's expected-exit handler is
      // tested against the platform's actual settle direction.
      current.reject(new Error("container destroyed"));
    },
    monitor() {
      monitorCalls++;
      return current.promise;
    },
  } as unknown as NonNullable<DurableObjectState["container"]>;

  return {
    container,
    get starts() {
      return starts;
    },
    get destroys() {
      return destroys;
    },
    get monitorCalls() {
      return monitorCalls;
    },
    get current() {
      return current;
    },
    generations,
  } as ReturnType<typeof makeContainer>;
}

// Lifecycle state is keyed by ctx — a tiny opaque object suffices.
function makeContext(container: NonNullable<DurableObjectState["container"]>): DurableObjectState {
  return { container } as unknown as DurableObjectState;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("formatExitReason", () => {
  test("returns 'exited normally' for resolve case (no error)", () => {
    expect(formatExitReason(undefined)).toBe("exited normally");
  });

  test("returns the Error message for an Error", () => {
    expect(formatExitReason(new Error("OOM killed"))).toBe("OOM killed");
  });

  test("falls back to String() for non-Error rejections", () => {
    expect(formatExitReason(42)).toBe("42");
  });
});

describe("installContainerMonitor", () => {
  test("records exit info when the monitor resolves (clean exit)", async () => {
    // container.monitor() resolves only on a clean code-0 exit on
    // the real platform. The lifecycle treats that as 'exited
    // normally' — useful when the workload exits on its own
    // rather than being SIGKILL'd by the runtime.
    const fake = makeContainer();
    const ctx = makeContext(fake.container);
    resetContainerLifecycleForTests(ctx);
    fake.container.start();
    installContainerMonitor(ctx, fake.container);

    expect(containerExitInfo(ctx)).toBeNull();
    fake.current.resolve();
    // Microtask drain.
    await Promise.resolve();
    await Promise.resolve();

    const exit = containerExitInfo(ctx);
    expect(exit).not.toBeNull();
    expect(exit?.reason).toBe("exited normally");
    expect(exit?.exitedAt).toBe(Date.now());
  });

  test("records the rejection reason and runs current-generation cleanup", async () => {
    const fake = makeContainer();
    const ctx = makeContext(fake.container);
    const cleanup = vi.fn(async () => {});
    resetContainerLifecycleForTests(ctx);
    fake.container.start();
    installContainerMonitor(ctx, fake.container, cleanup);

    fake.current.reject(new Error("container crashed"));
    await Promise.resolve();
    await Promise.resolve();

    const exit = containerExitInfo(ctx);
    expect(exit?.reason).toBe("container crashed");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  test("logs at warn level on an unexpected exit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = makeContainer();
    const ctx = makeContext(fake.container);
    resetContainerLifecycleForTests(ctx);
    fake.container.start();
    installContainerMonitor(ctx, fake.container);

    fake.current.reject(new Error("OOM killed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledTimes(1);
    const [arg] = warn.mock.calls[0] ?? [];
    expect(arg).toMatchObject({
      message: "workspace.container.exited",
      reason: "OOM killed",
      expected: false,
    });
  });

  test("logs at info level when the exit was expected (after destroyContainerExpectingExit)", async () => {
    // The platform monitor() rejects on destroy. The lifecycle
    // snapshots expectingExit at arm time, so even though the
    // destroy's finally clears the flag synchronously, the
    // monitor handler that fires later still sees expected:true.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fake = makeContainer();
    const ctx = makeContext(fake.container);
    resetContainerLifecycleForTests(ctx);
    fake.container.start();
    installContainerMonitor(ctx, fake.container);

    await destroyContainerExpectingExit(ctx, fake.container);
    // Drain the monitor's then-chain.
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    const [arg] = info.mock.calls[0] ?? [];
    expect(arg).toMatchObject({
      message: "workspace.container.exited",
      expected: true,
      reason: "container destroyed",
    });
  });

  test("a late-rejecting stale monitor does not poison a new generation", async () => {
    // First generation arms its monitor; we leave it pending.
    // Second generation arms a new monitor (incrementing the
    // generation counter). The stale handler firing after the
    // new generation has armed must NOT overwrite the new
    // generation's clean exit state.
    const fake = makeContainer();
    const ctx = makeContext(fake.container);
    resetContainerLifecycleForTests(ctx);

    const staleCleanup = vi.fn(async () => {});
    fake.container.start();
    const firstGeneration = fake.current;
    installContainerMonitor(ctx, fake.container, staleCleanup);

    // Second generation — a new monitor promise is armed in the
    // fake's start(); installContainerMonitor bumps the lifecycle's
    // generation counter and attaches a fresh handler against the
    // new promise.
    fake.container.start();
    installContainerMonitor(ctx, fake.container);
    const secondGeneration = fake.current;

    expect(containerExitInfo(ctx)).toBeNull();
    // Settle the stale monitor with an error — it must be
    // ignored because its generation is no longer current.
    firstGeneration.reject(new Error("old generation died long ago"));
    await Promise.resolve();
    await Promise.resolve();
    expect(containerExitInfo(ctx)).toBeNull();
    expect(staleCleanup).not.toHaveBeenCalled();

    // The current generation's monitor still records normally.
    secondGeneration.reject(new Error("current generation died"));
    await Promise.resolve();
    await Promise.resolve();
    expect(containerExitInfo(ctx)?.reason).toBe("current generation died");
  });
});

describe("destroyContainerExpectingExit", () => {
  test("resets expectingExit so the next generation's crash logs as a crash", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = makeContainer();
    const ctx = makeContext(fake.container);
    resetContainerLifecycleForTests(ctx);
    fake.container.start();
    installContainerMonitor(ctx, fake.container);

    await destroyContainerExpectingExit(ctx, fake.container);
    await Promise.resolve();
    await Promise.resolve();
    // Arm a fresh monitor for a new container generation.
    fake.container.start();
    installContainerMonitor(ctx, fake.container);
    fake.current.reject(new Error("real crash"));
    await Promise.resolve();
    await Promise.resolve();

    // The second exit was unexpected; it must log as a crash.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("expected-exit log fires for restart even when monitor settles after destroy resolves", async () => {
    // Production timing: the platform settles container.monitor()
    // asynchronously relative to container.destroy(). If the
    // expected-exit log is gated on the monitor handler running
    // *before* the next generation is installed, the log is
    // silently dropped. destroyContainerExpectingExit must await
    // the destroyed generation's monitor handler before
    // returning so the caller can install the next generation
    // without superseding the pending log.
    //
    // Real timers here — we need setTimeout to actually fire so
    // the deferred reject straddles a task boundary the way
    // production does. Restore fake timers at the end so the
    // surrounding beforeEach/afterEach contract holds.
    vi.useRealTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Custom container where destroy() does NOT settle the
    // monitor synchronously; instead it schedules the rejection
    // for a later microtask, mirroring the platform's behavior.
    let monitorReject: ((error: unknown) => void) | null = null;
    let monitorPromise = new Promise<void>((_, reject) => {
      monitorReject = reject;
    });
    monitorPromise.catch(() => {});
    const container = {
      get running() {
        return true;
      },
      start() {
        // New generation arms a fresh monitor promise.
        monitorPromise = new Promise<void>((_, reject) => {
          monitorReject = reject;
        });
        monitorPromise.catch(() => {});
      },
      async destroy() {
        // Capture the current rejector; settle it on a macrotask
        // so the destroy() resolution and the monitor rejection
        // straddle a task boundary. This mirrors production
        // timing — the platform's destroy can return before its
        // monitor() promise settles, and microtask-only ordering
        // (queueMicrotask, Promise.resolve) would mask the race.
        const reject = monitorReject;
        setTimeout(() => {
          reject?.(new Error("deferred destroy reject"));
        }, 0);
      },
      monitor() {
        return monitorPromise;
      },
    } as unknown as NonNullable<DurableObjectState["container"]>;
    const ctx = makeContext(container);
    resetContainerLifecycleForTests(ctx);

    container.start();
    installContainerMonitor(ctx, container);

    await destroyContainerExpectingExit(ctx, container);
    // Immediately install the next generation, as restart() does.
    container.start();
    installContainerMonitor(ctx, container);

    // Drain any pending tasks (including the macrotask the fake
    // queued from destroy).
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();

    // The destroyed generation's exit must have logged as
    // expected (info), not as a crash (warn).
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      message: "workspace.container.exited",
      expected: true,
    });
    expect(warn).not.toHaveBeenCalled();

    vi.useFakeTimers();
  });

  test("a later real crash on a fresh generation logs as unexpected after a failed destroy", async () => {
    // destroy() rejects against generation 1. The expected-exit
    // mark sticks against generation 1. A subsequent start()
    // arms generation 2; a crash on generation 2 must be logged
    // as unexpected because the mark targets a generation that
    // no longer matches the live one.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = makeContainer();
    const ctx = makeContext(fake.container);
    resetContainerLifecycleForTests(ctx);
    fake.container.start();
    installContainerMonitor(ctx, fake.container);

    const broken = {
      destroy: async () => {
        throw new Error("destroy rejected");
      },
    } as unknown as NonNullable<DurableObjectState["container"]>;
    await expect(destroyContainerExpectingExit(ctx, broken)).rejects.toThrow(/destroy rejected/);

    // Fresh generation, fresh monitor.
    fake.container.start();
    installContainerMonitor(ctx, fake.container);
    fake.current.reject(new Error("real crash"));
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ expected: false });
  });
});

describe("getContainerLifecycle", () => {
  test("returns null exit info before any monitor has fired", () => {
    const fake = makeContainer();
    const ctx = makeContext(fake.container);
    resetContainerLifecycleForTests(ctx);
    expect(containerExitInfo(ctx)).toBeNull();
    expect(getContainerLifecycle(ctx).exit).toBeNull();
  });

  test("isolates state per ctx via the WeakMap", async () => {
    const a = makeContainer();
    const b = makeContainer();
    const ctxA = makeContext(a.container);
    const ctxB = makeContext(b.container);
    resetContainerLifecycleForTests(ctxA);
    resetContainerLifecycleForTests(ctxB);
    a.container.start();
    installContainerMonitor(ctxA, a.container);
    b.container.start();
    installContainerMonitor(ctxB, b.container);

    a.current.reject(new Error("a crashed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(containerExitInfo(ctxA)?.reason).toBe("a crashed");
    expect(containerExitInfo(ctxB)).toBeNull();
  });
});
