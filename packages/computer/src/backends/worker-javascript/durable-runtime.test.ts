import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { durableRuntimeModule } from "./durable-runtime.js";

interface Payload {
  result?: unknown;
  at?: number;
  ordinal?: number;
}

interface DurableExports {
  install(
    durable: { seed: string; startedAt: number; schedule: number[] },
    host: { reportStall(): unknown; recordLog(log: unknown): unknown },
    call: (...args: unknown[]) => Promise<unknown>,
  ): void;
  request(): void;
  failed(): void;
  deliver(payload: Payload): Promise<Payload> | Payload;
  takeLog(): { from: number; events: number[] } | undefined;
}

// Load the module into its own realm, as the isolate would, so the
// globals it replaces aren't this process's.
function load(
  schedule: number[],
  seed = "0".repeat(64),
  call: (...args: unknown[]) => Promise<unknown> = async () => null,
) {
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    crypto: {},
    performance: {},
    AbortSignal: {},
    AbortController,
    scheduler: { wait: () => undefined },
    DOMException,
    Request,
    Response,
  });
  const source = durableRuntimeModule().replace(/export function/g, "function");
  const durable = vm.runInContext(
    `${source}\n({ install, request, failed, deliver, takeLog });`,
    context,
  ) as DurableExports;
  const reportStall = vi.fn<() => void>();
  const recordLog = vi.fn<(log: unknown) => void>();
  durable.install({ seed, startedAt: 1000, schedule }, { reportStall, recordLog }, call);
  const run = <T>(code: string) => vm.runInContext(code, context) as T;
  return { durable, reportStall, recordLog, run, context };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function track(durable: DurableExports, payload: Payload, seen: unknown[]) {
  durable.request();
  void Promise.resolve(durable.deliver(payload)).then((value) => seen.push(value.result));
}

describe("durable runtime", () => {
  it("releases replayed responses in the order the log gives", async () => {
    const { durable, run } = load([2, 1]);
    const seen: unknown[] = [];
    track(durable, { result: "a", ordinal: 1, at: 1010 }, seen);
    track(durable, { result: "b", ordinal: 2, at: 1020 }, seen);
    await settle();
    expect(seen).toEqual(["b", "a"]);
    expect(run("Date.now()")).toBe(1020);
  });

  it("fires a timer where the log placed it, whatever its delay", async () => {
    // Set first, so it's timer 1. It fired after both responses, as a
    // timer does when the code computes past its due time.
    const { durable, run } = load([1, 2, -1]);
    const seen: unknown[] = [];
    run("globalThis.fired = []; setTimeout(() => fired.push(Date.now()), 0)");
    track(durable, { result: "a", ordinal: 1, at: 1010 }, seen);
    track(durable, { result: "b", ordinal: 2, at: 1100 }, seen);
    await settle();
    expect(seen).toEqual(["a", "b"]);
    expect(run("fired")).toEqual([1100]);
  });

  it("fires a timer between the responses the log put it between", async () => {
    const { durable, run } = load([1, -1, 2]);
    const seen: unknown[] = [];
    run("globalThis.order = []; setTimeout(() => order.push('timer'), 500)");
    durable.request();
    void Promise.resolve(durable.deliver({ result: "a", ordinal: 1, at: 1010 })).then(() =>
      run("order.push('a')"),
    );
    track(durable, { result: "b", ordinal: 2, at: 1020 }, seen);
    await settle();
    expect(run("order")).toEqual(["a", "timer"]);
    expect(seen).toEqual(["b"]);
    // The timer's due time is past the second response's, and the clock
    // never runs backwards.
    expect(run("Date.now()")).toBe(1500);
  });

  it("holds a response the log doesn't place until the replay is done", async () => {
    const { durable } = load([1]);
    const seen: unknown[] = [];
    track(durable, { result: "live", ordinal: 5, at: 1005 }, seen);
    await settle();
    expect(seen).toEqual([]);
    track(durable, { result: "replayed", ordinal: 1, at: 1010 }, seen);
    await settle();
    expect(seen).toEqual(["replayed", "live"]);
  });

  it("passes an unjournaled response straight through", async () => {
    const { durable } = load([1]);
    const seen: unknown[] = [];
    track(durable, { result: "refused" }, seen);
    await settle();
    expect(seen).toEqual(["refused"]);
  });

  it("logs the order a live run sees its events in", async () => {
    const { durable, run } = load([]);
    run("setTimeout(() => {}, 10)");
    track(durable, { result: "a", ordinal: 3, at: 1001 }, []);
    await settle(40);
    expect(durable.takeLog()).toEqual({ from: 0, events: [3, -1] });
    expect(durable.takeLog()).toBeUndefined();
  });

  it("logs new events after the ones it replayed", async () => {
    const { durable } = load([1]);
    track(durable, { result: "a", ordinal: 1, at: 1010 }, []);
    track(durable, { result: "b", ordinal: 2, at: 1020 }, []);
    await settle();
    expect(durable.takeLog()).toEqual({ from: 1, events: [2] });
  });

  it("sends a long log on its own rather than holding it for the next call", async () => {
    const { durable, recordLog, run } = load([]);
    run("for (let i = 0; i < 5000; i++) setTimeout(() => {}, 0)");
    await settle(100);
    expect(recordLog).toHaveBeenCalledOnce();
    const [chunk] = recordLog.mock.calls[0] as [{ from: number; events: number[] }];
    expect(chunk.from).toBe(0);
    expect(chunk.events).toHaveLength(4096);
    expect(durable.takeLog()).toMatchObject({ from: 4096 });
  });

  it("gives timers left after the replay their remaining real delay", async () => {
    const { durable, run } = load([1]);
    run("globalThis.fired = []; setTimeout(() => fired.push(Date.now()), 40)");
    track(durable, { result: "a", ordinal: 1, at: 1010 }, []);
    await settle(5);
    expect(run("fired")).toEqual([]);
    await settle(80);
    expect(run("fired")).toEqual([1040]);
    expect(durable.takeLog()).toEqual({ from: 1, events: [-1] });
  });

  it("reports a replay that stops making the calls it made before", async () => {
    const { reportStall } = load([1010]);
    await settle(1300);
    expect(reportStall).toHaveBeenCalledOnce();
  });

  it("doesn't report a stall while a call is in flight", async () => {
    const { durable, reportStall } = load([1010]);
    durable.request();
    await settle(1300);
    expect(reportStall).not.toHaveBeenCalled();
  });

  it("draws random bytes from ChaCha20 over the seed", () => {
    // RFC 8439 A.1, test vector 1: an all-zero key, nonce and counter.
    const { run } = load([]);
    expect(run<number[]>("[...crypto.getRandomValues(new Uint8Array(8))]")).toEqual([
      0x76, 0xb8, 0xe0, 0xad, 0xa0, 0xf1, 0x3d, 0x90,
    ]);
  });

  it("repeats random numbers for the same seed", () => {
    const seed = "a1".repeat(32);
    const draw = () => load([], seed).run<string>("[Math.random(), crypto.randomUUID()].join(' ')");
    const first = draw();
    expect(draw()).toBe(first);
    expect(first).toMatch(
      /^0\.\d+ [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(load([], "b2".repeat(32)).run("Math.random()")).not.toBe(Number(first.split(" ")[0]));
  });

  it("hands back Node timer handles when the real timers do", async () => {
    // Node's own setTimeout returns Timeout objects, as workerd's does
    // under nodejs_compat.
    const { run } = load([]);
    run(`
      globalThis.fired = [];
      const cleared = setTimeout(() => fired.push("cleared"), 5);
      cleared.unref();
      clearTimeout(cleared);
      setTimeout(() => fired.push("refreshed"), 5).refresh();
      globalThis.handle = setTimeout(() => {}, 0);
    `);
    await settle();
    expect(run("fired")).toEqual(["refreshed"]);
    expect(run("handle.hasRef() && typeof Number(handle)")).toBe("number");
  });

  it("sends fetch through the host with its redirect mode", async () => {
    const call = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      status: 302,
      statusText: "Found",
      headers: [],
      body: null,
    }));
    const { run } = load([], undefined, call);
    const status = await run<Promise<number>>(
      "fetch('https://example.test/a', { redirect: 'manual' }).then((response) => response.status)",
    );
    expect(status).toBe(302);
    expect(call).toHaveBeenCalledWith("net", "fetch", [
      expect.objectContaining({ url: "https://example.test/a", method: "GET", redirect: "manual" }),
    ]);
  });

  it("lets a signal cancel scheduler.wait", async () => {
    const { run } = load([]);
    run(`
      globalThis.waits = [];
      const early = new AbortController();
      early.abort(new DOMException("early", "AbortError"));
      scheduler.wait(5, { signal: early.signal }).catch((error) => waits.push(error.message));
      const later = new AbortController();
      scheduler.wait(30, { signal: later.signal }).then(
        () => waits.push("resolved"),
        (error) => waits.push(error.message),
      );
      setTimeout(() => later.abort(new DOMException("later", "AbortError")), 5);
    `);
    await settle(60);
    expect(run("waits")).toEqual(["early", "later"]);
  });

  it("keeps Date subclasses working", () => {
    const { run } = load([]);
    expect(
      run("class Day extends Date {}; const day = new Day(); day instanceof Day && day.getTime()"),
    ).toBe(1000);
  });

  it("measures performance.now from the run's start", async () => {
    const { durable, run } = load([1]);
    track(durable, { result: "a", ordinal: 1, at: 1250 }, []);
    await settle();
    expect(run("performance.now()")).toBe(250);
  });
});
