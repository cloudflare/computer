// Stub-disposal soak across the Workers RPC boundary.
//
// The unit tests in src/stub.test.ts exercise the WorkspaceStub
// classes in-process; they don't see the Workers-RPC disposal
// contract because no boundary is crossed. This soak does: it
// reaches into the DO via the COMPUTERD binding, pulls a WorkspaceStub
// across the boundary, exercises fs + shell, and samples the
// per-class live counter on the DO side.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ComputerdContainer, Env } from "./stub-soak-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

interface SoakResult {
  baseline: Record<string, number>;
  afterIterations: Record<string, number>;
  afterClose: Record<string, number>;
  iterations: number;
}

async function runSoak(
  iterations: number,
  opts: { disposeStubs: boolean; disposeExecHandles: boolean },
): Promise<SoakResult> {
  const id = env.COMPUTERD.idFromName(`soak-${Math.random()}`);
  const stub = env.COMPUTERD.get(id);

  const baseline = await stub.stubSnapshot();

  for (let i = 0; i < iterations; i++) {
    const ws = await stub.getWorkspace();
    await ws.fs.writeFile(`/soak-${i}.txt`, `hello ${i}`);
    await ws.fs.readFile(`/soak-${i}.txt`, "utf8");
    const handle = await ws.runtime.exec("noop");
    await handle.result();
    if (opts.disposeExecHandles) {
      (handle as unknown as Disposable)[Symbol.dispose]?.();
    }
    if (opts.disposeStubs) {
      (ws as unknown as Disposable)[Symbol.dispose]?.();
    }
  }

  const afterIterations = await stub.stubSnapshot();

  // Let the runtime flush deferred disposers / GC of stubs whose
  // caller-side proxies fell out of scope above.
  await scheduler.wait(50);
  const afterClose = await stub.stubSnapshot();

  return { baseline, afterIterations, afterClose, iterations };
}

function diff(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[k] = (b[k] ?? 0) - (a[k] ?? 0);
  }
  return out;
}

describe("WorkspaceStub disposal soak (DO ↔ Worker)", () => {
  // The DO is a singleton per id but the same isolate hosts all
  // four cases in this file, so counters from earlier cases bleed
  // forward. Use distinct DO names per case and reason about
  // *deltas* (afterClose - baseline) rather than absolute values.

  it("steady state: 20 iterations with explicit caller-side disposal", async () => {
    // The expected contract: when the caller disposes every
    // returned stub, the DO-side counters return to baseline.
    // Disposing WorkspaceStub cascades to its #fs / #shell
    // children; disposing WorkspaceRuntimeExecHandleStub releases the
    // exec handle. Anything non-zero here is a leak.
    const result = await runSoak(20, { disposeStubs: true, disposeExecHandles: true });
    const growth = diff(result.baseline, result.afterClose);
    console.log("[stub-soak][with-dispose]", JSON.stringify(result, null, 2));
    for (const [k, v] of Object.entries(growth)) {
      expect(v, `${k} leaked ${v}; full snapshot:\n${JSON.stringify(result, null, 2)}`).toBe(0);
    }
  });

  it("documents the leak shape when the caller disposes nothing", async () => {
    // Without explicit caller-side disposal, every iteration adds
    // one of each stub class on the DO side. Pin the shape so a
    // regression in either direction (smaller — capnweb learned to
    // auto-dispose; larger — we leaked something new) is visible.
    const result = await runSoak(10, { disposeStubs: false, disposeExecHandles: false });
    const growth = diff(result.baseline, result.afterClose);
    console.log("[stub-soak][no-dispose]", JSON.stringify(result, null, 2));
    expect(growth, JSON.stringify(result, null, 2)).toMatchObject({
      WorkspaceStub: 10,
      WorkspaceFilesystemStub: 10,
      WorkspaceRuntimeStub: 10,
      WorkspaceRuntimeExecHandleStub: 10,
    });
  });

  it("snapshot reads do not themselves grow counters", async () => {
    // Sanity check: stubSnapshot() must not leak. Without this
    // pin a regression in the snapshot path could mask real leaks.
    const id = env.COMPUTERD.idFromName("snapshot-only");
    const stub = env.COMPUTERD.get(id);
    const a = await stub.stubSnapshot();
    for (let i = 0; i < 5; i++) await stub.stubSnapshot();
    const b = await stub.stubSnapshot();
    expect(diff(a, b)).toEqual(Object.fromEntries(Object.keys(diff(a, b)).map((k) => [k, 0])));
  });

  it("runInDurableObject reaches the same counters as the RPC path", async () => {
    // Cross-check: the in-DO snapshot path returns the same shape
    // (string → number) as the RPC one. The actual numbers depend
    // on whatever ran before in this isolate — counters are
    // module-level state — so we only assert on the type.
    const id = env.COMPUTERD.idFromName("direct-access");
    const stub = env.COMPUTERD.get(id);
    const snap = await runInDurableObject(stub, async (instance: ComputerdContainer) => {
      return instance.stubSnapshot();
    });
    for (const v of Object.values(snap)) expect(typeof v).toBe("number");
  });
});
