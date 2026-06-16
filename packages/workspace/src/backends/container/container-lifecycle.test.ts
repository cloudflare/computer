import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  armContainerMonitor,
  containerExitInfo,
  destroyContainerExpectingExit,
  formatExitReason,
  getContainerLifecycle,
  resetContainerLifecycleForTests,
} from "./container-lifecycle.js";

// Minimal Container stand-in. The lifecycle module only touches
// .destroy(), .start(), .running, and .monitor(). A controllable
// monitor() promise lets the tests drive the exit signal
// deterministically.
function makeContainer(): {
  container: NonNullable<DurableObjectState["container"]>;
  starts: number;
  destroys: number;
  monitorCalls: number;
  resolveMonitor: () => void;
  rejectMonitor: (error: unknown) => void;
  monitorPromise: () => Promise<void>;
} {
  let starts = 0;
  let destroys = 0;
  let monitorCalls = 0;
  let running = false;
  let resolveMonitor!: () => void;
  let rejectMonitor!: (error: unknown) => void;
  let monitorPromise: Promise<void>;

  function armPromise() {
    monitorPromise = new Promise<void>((resolve, reject) => {
      resolveMonitor = resolve;
      rejectMonitor = reject;
    });
    // Swallow unhandled rejection noise when the test path leaves
    // the promise pending or rejects without awaiting it.
    monitorPromise.catch(() => {});
  }
  armPromise();

  const container = {
    get running() {
      return running;
    },
    start(_options?: unknown) {
      starts++;
      running = true;
      // Each start() arms a fresh monitor() that the next monitor()
      // call returns.
      armPromise();
    },
    async destroy() {
      destroys++;
      running = false;
      // destroy() resolves the in-flight monitor() cleanly.
      resolveMonitor();
    },
    monitor() {
      monitorCalls++;
      return monitorPromise;
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
    resolveMonitor: () => resolveMonitor(),
    rejectMonitor: (error: unknown) => rejectMonitor(error),
    monitorPromise: () => monitorPromise,
  } as ReturnType<typeof makeContainer>;
}

// Lifecycle state is keyed by ctx — a tiny opaque object suffices.
function makeCtx(container: NonNullable<DurableObjectState["container"]>): DurableObjectState {
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

describe("armContainerMonitor", () => {
  test("records exit info when the monitor resolves", async () => {
    const fake = makeContainer();
    const ctx = makeCtx(fake.container);
    resetContainerLifecycleForTests(ctx);
    fake.container.start();
    armContainerMonitor(ctx, fake.container);

    expect(containerExitInfo(ctx)).toBeNull();
    fake.resolveMonitor();
    // Microtask drain.
    await Promise.resolve();
    await Promise.resolve();

    const exit = containerExitInfo(ctx);
    expect(exit).not.toBeNull();
    expect(exit?.reason).toBe("exited normally");
    expect(exit?.exitedAt).toBe(Date.now());
  });

  test("records the rejection reason when the monitor rejects", async () => {
    const fake = makeContainer();
    const ctx = makeCtx(fake.container);
    resetContainerLifecycleForTests(ctx);
    fake.container.start();
    armContainerMonitor(ctx, fake.container);

    fake.rejectMonitor(new Error("container crashed"));
    await Promise.resolve();
    await Promise.resolve();

    const exit = containerExitInfo(ctx);
    expect(exit?.reason).toBe("container crashed");
  });

  test("logs at warn level on an unexpected exit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = makeContainer();
    const ctx = makeCtx(fake.container);
    resetContainerLifecycleForTests(ctx);
    fake.container.start();
    armContainerMonitor(ctx, fake.container);

    fake.rejectMonitor(new Error("OOM killed"));
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fake = makeContainer();
    const ctx = makeCtx(fake.container);
    resetContainerLifecycleForTests(ctx);
    fake.container.start();
    armContainerMonitor(ctx, fake.container);

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
    });
  });

  test("does not arm twice for the same container generation", () => {
    const fake = makeContainer();
    const ctx = makeCtx(fake.container);
    resetContainerLifecycleForTests(ctx);
    fake.container.start();
    armContainerMonitor(ctx, fake.container);
    armContainerMonitor(ctx, fake.container);
    expect(fake.monitorCalls).toBe(1);
  });
});

describe("destroyContainerExpectingExit", () => {
  test("clears the expectingExit flag after destroy() resolves", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = makeContainer();
    const ctx = makeCtx(fake.container);
    resetContainerLifecycleForTests(ctx);
    fake.container.start();
    armContainerMonitor(ctx, fake.container);

    await destroyContainerExpectingExit(ctx, fake.container);
    await Promise.resolve();
    await Promise.resolve();
    // Arm a fresh monitor for a new container generation.
    fake.container.start();
    armContainerMonitor(ctx, fake.container);
    fake.rejectMonitor(new Error("real crash"));
    await Promise.resolve();
    await Promise.resolve();

    // The second exit was unexpected; it must log as a crash.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("clears the expectingExit flag even if destroy() throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = makeContainer();
    const ctx = makeCtx(fake.container);
    resetContainerLifecycleForTests(ctx);
    fake.container.start();
    armContainerMonitor(ctx, fake.container);
    const broken = {
      destroy: async () => {
        throw new Error("destroy rejected");
      },
    } as unknown as NonNullable<DurableObjectState["container"]>;

    await expect(destroyContainerExpectingExit(ctx, broken)).rejects.toThrow(/destroy rejected/);

    // A later real crash must still log as unexpected.
    fake.rejectMonitor(new Error("real crash"));
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("getContainerLifecycle", () => {
  test("returns null exit info before any monitor has fired", () => {
    const fake = makeContainer();
    const ctx = makeCtx(fake.container);
    resetContainerLifecycleForTests(ctx);
    expect(containerExitInfo(ctx)).toBeNull();
    expect(getContainerLifecycle(ctx).exit).toBeNull();
  });

  test("isolates state per ctx via the WeakMap", async () => {
    const a = makeContainer();
    const b = makeContainer();
    const ctxA = makeCtx(a.container);
    const ctxB = makeCtx(b.container);
    resetContainerLifecycleForTests(ctxA);
    resetContainerLifecycleForTests(ctxB);
    a.container.start();
    armContainerMonitor(ctxA, a.container);
    b.container.start();
    armContainerMonitor(ctxB, b.container);

    a.rejectMonitor(new Error("a crashed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(containerExitInfo(ctxA)?.reason).toBe("a crashed");
    expect(containerExitInfo(ctxB)).toBeNull();
  });
});
