// Durable REPL sessions — core eval loop behavior tests.
//
// Seam under test: `workspace.repl(name).eval(code)` through a Durable
// Object host on real workerd with a real Worker Loader binding.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env, ReplHostDO } from "./repl-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

let hostSeq = 0;
function host(): DurableObjectStub<ReplHostDO> {
  return env.HOST.get(env.HOST.idFromName(`host-${++hostSeq}`));
}

describe("repl session eval", () => {
  it("returns the trailing expression as value, with ordered leveled logs", async () => {
    const h = host();
    const result = await h.replEval("main", [
      "console.log('starting', { n: 1 });",
      "console.warn('careful');",
      "console.log('resuming');",
      "console.error('bad');",
      "const doubled = 21 * 2;",
      "doubled",
    ].join("\n"));
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(42);
    expect(result.executionCount).toBe(1);
    // One stream: emission order and levels both survive.
    expect(result.logs.entries).toEqual([
      { level: "log", text: "starting { n: 1 }" },
      { level: "warn", text: "careful" },
      { level: "log", text: "resuming" },
      { level: "error", text: "bad" },
    ]);
    expect(result.logs.dropped).toBeUndefined();
  });

  it("persists bindings across evals: const, let, function, class, destructuring", async () => {
    const h = host();
    await h.replEval("main", "const base = 10; let count = 0;");
    await h.replEval("main", "function bump(n) { count += n; return count; }");
    await h.replEval("main", "class Acc { constructor() { this.total = 0; } add(n) { this.total += n; return this; } }");
    await h.replEval("main", "const { a, ...rest } = { a: 1, b: 2, c: 3 };");
    const result = await h.replEval(
      "main",
      "return { bumped: bump(5), acc: new Acc().add(base).total, a, rest };",
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ bumped: 5, acc: 10, a: 1, rest: { b: 2, c: 3 } });
    expect(result.executionCount).toBe(5);
  });

  it("keeps sessions independent by name", async () => {
    const h = host();
    await h.replEval("one", "const x = 1;");
    await h.replEval("two", "const x = 2;");
    expect((await h.replEval("one", "x")).value).toBe(1);
    expect((await h.replEval("two", "x")).value).toBe(2);
  });

  it("survives a restart: state rebuilt exactly, recorded effects not re-rolled", async () => {
    const h = host();
    await h.replEval("main", [
      "const rolls = [Math.random(), Math.random()];",
      "const stamp = Date.now();",
      "const id = crypto.randomUUID();",
      "const when = new Date();",
      "const iso = when.toISOString();",
      "const dateStr = Date();",
      "const perf = performance.now();",
      "const bytes = Array.from(crypto.getRandomValues(new Uint8Array(8)));",
      "const derived = rolls.map((r) => Math.floor(r * 1000));",
    ].join("\n"));
    const before = await h.replEval(
      "main",
      "return { rolls, stamp, id, iso, dateStr, perf, bytes, derived, whenMs: when.getTime() };",
    );
    expect(before.error).toBeUndefined();

    await h.restart();

    const after = await h.replEval(
      "main",
      "return { rolls, stamp, id, iso, dateStr, perf, bytes, derived, whenMs: when.getTime() };",
    );
    expect(after.error).toBeUndefined();
    expect(after.value).toEqual(before.value);
    expect(after.executionCount).toBe(3);
  });

  it("keeps Date semantics intact around the clock shim", async () => {
    const h = host();
    const result = await h.replEval("main", [
      "const epoch = new Date(0);",
      "return {",
      "  isDate: new Date() instanceof Date,",
      "  epochIso: epoch.toISOString(),",
      "  parsed: Date.parse('2024-01-02T03:04:05.000Z'),",
      "  fromParts: new Date(2024, 0, 2).getFullYear(),",
      "};",
    ].join("\n"));
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      isDate: true,
      epochIso: "1970-01-01T00:00:00.000Z",
      parsed: 1704164645000,
      fromParts: 2024,
    });
  });

  it("removes unreplayable globals: WeakRef, FinalizationRegistry, caches", async () => {
    const h = host();
    const result = await h.replEval(
      "main",
      "return [typeof WeakRef, typeof FinalizationRegistry, typeof caches];",
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(["undefined", "undefined", "undefined"]);
  });

  it("never commits a failed cell; the session continues from the last good state", async () => {
    const h = host();
    await h.replEval("main", "const safe = 'intact'; let steps = 0;");
    const failed = await h.replEval("main", "steps += 1;\nthrow new Error('boom');");
    expect(failed.error?.name).toBe("Error");
    expect(failed.error?.message).toBe("boom");
    expect(failed.error?.traceback).toContain("boom");
    expect(failed.executionCount).toBe(2);

    // The failed cell's mutation must not survive (it never entered the log).
    const result = await h.replEval("main", "return { safe, steps };");
    expect(result.value).toEqual({ safe: "intact", steps: 0 });
    expect(result.executionCount).toBe(2);
  });

  it("reports syntax errors as results and stays usable", async () => {
    const h = host();
    const bad = await h.replEval("main", "const = nope;");
    expect(bad.error?.name).toBe("SyntaxError");
    const ok = await h.replEval("main", "1 + 1");
    expect(ok.value).toBe(2);
    expect(ok.executionCount).toBe(1);
  });

  it("omits unclonable values but renders them, without failing the cell", async () => {
    const h = host();
    const result = await h.replEval("main", "const fn = (x) => x + 1;\nfn");
    expect(result.error).toBeUndefined();
    expect("value" in result).toBe(false);
    expect(result.results[0]?.text).toContain("Function");

    // The binding itself still persists and works.
    const use = await h.replEval("main", "fn(41)");
    expect(use.value).toBe(42);
  });

  // A `while (true) {}` spin would rely on the loader's cpuMs limit, which
  // local workerd doesn't enforce (it wedges the test process). An async
  // hang exercises the host-side wall-clock timeout honestly.
  it("times out hung cells without committing them", async () => {
    const h = host();
    await h.replEval("main", "const alive = true;");
    const result = await h.replEval("main", "await new Promise(() => {});", { timeoutMs: 500 });
    expect(result.error).toBeDefined();
    expect(result.error?.kind).toBe("timeout");

    const ok = await h.replEval("main", "alive");
    expect(ok.value).toBe(true);
    expect(ok.executionCount).toBe(2);
  });

  it("surfaces dropped console entries instead of losing them silently", async () => {
    const h = host();
    const result = await h.replEval("main", "for (let i = 0; i < 1005; i++) console.log(i);");
    expect(result.error).toBeUndefined();
    expect(result.logs.entries).toHaveLength(1000);
    expect(result.logs.entries[999]).toEqual({ level: "log", text: "999" });
    expect(result.logs.dropped).toBe(5);
  });

  it("reports console output only from the new cell, not replayed ones", async () => {
    const h = host();
    await h.replEval("main", "console.log('cell one noise');");
    const result = await h.replEval("main", "console.log('cell two'); 7");
    expect(result.logs.entries).toEqual([{ level: "log", text: "cell two" }]);
    expect(result.value).toBe(7);
  });

  it("serializes concurrent evals on one session in arrival order", async () => {
    const h = host();
    // The second cell only works if the first fully committed before it ran.
    const [a, b] = await h.replEvalPair("main", "let n = 1;\nn", "n += 1;\nn");
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(a.value).toBe(1);
    expect(b.value).toBe(2);
    expect(a.executionCount).toBe(1);
    expect(b.executionCount).toBe(2);
  });

  it("fails loudly with replay-divergence when the log no longer matches (kind mismatch)", async () => {
    const h = host();
    await h.replEval("main", "const roll = Math.random(); const tag = 'kept';");
    await h.restart(); // drop the cached in-memory log
    await h.corruptEffectKinds("main");

    const result = await h.replEval("main", "roll");
    expect(result.error?.kind).toBe("replay-divergence");
    expect(result.error?.message).toContain("replay");
    // The failing eval was not committed.
    expect(result.executionCount).toBe(2);
  });

  it("fails loudly with replay-divergence when recorded effects go unconsumed", async () => {
    const h = host();
    await h.replEval("main", "const roll = Math.random();");
    await h.restart();
    await h.injectExtraEffect("main", 1);

    const result = await h.replEval("main", "roll");
    expect(result.error?.kind).toBe("replay-divergence");
    expect(result.error?.message).toContain("never consumed");
  });
});
