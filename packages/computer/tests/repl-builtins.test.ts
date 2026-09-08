// Durable REPL sessions — in-session built-in tests: help() and emit().
//
// Runs against real workerd. The discipline under test: built-ins are not
// capabilities and are never recorded. help() is a pure function of the
// cell's injected grant shapes (replayed cells see their recorded
// snapshot, so committed help() calls survive revocation and restart),
// and emit() fills a per-cell display buffer — replayed cells' emits are
// discarded exactly like their console output.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ReplHostDO } from "./repl-worker.js";

let sessionCounter = 0;

function uniqueSession(): string {
  sessionCounter += 1;
  return `builtins-session-${sessionCounter}`;
}

function host() {
  const id = env.HOST.newUniqueId();
  return env.HOST.get(id);
}

describe("REPL help()", () => {
  it("overview lists built-ins and states when nothing is granted", async () => {
    const stub = host();
    const result = await stub.replEval(uniqueSession(), "help()");
    expect(result.error).toBeUndefined();
    const text = result.value as string;
    expect(text).toContain("help(");
    expect(text).toContain("emit(");
    expect(text).toContain("No capabilities are granted");
  });

  it("overview lists each grant with its description", async () => {
    const stub = host();
    const result = await stub.replEvalWith(["weather", "configV1"], uniqueSession(), "help()");
    expect(result.error).toBeUndefined();
    const text = result.value as string;
    expect(text).toContain("weather — Weather lookups");
    expect(text).toContain("config");
    expect(text).not.toContain("No capabilities are granted");
  });

  it("help(name) shows methods with grantor docs", async () => {
    const stub = host();
    const result = await stub.replEvalWith(["weather"], uniqueSession(), 'help("weather")');
    expect(result.error).toBeUndefined();
    const text = result.value as string;
    expect(text).toContain("Weather lookups");
    expect(text).toContain("get(city) → { city, temp, asOf }");
    expect(text).toContain("weather.flaky(");
  });

  it("help(name) walks nested children and data snapshots", async () => {
    const stub = host();
    const result = await stub.replEvalWith(["api"], uniqueSession(), 'help("api")');
    expect(result.error).toBeUndefined();
    const text = result.value as string;
    expect(text).toContain("api.users.list(");
    expect(text).toContain('api.version = "2.0"');
  });

  it("help(name) says so for opaque surfaces", async () => {
    const stub = host();
    const result = await stub.replEvalWith(["stub"], uniqueSession(), 'help("stub")');
    expect(result.error).toBeUndefined();
    expect(result.value as string).toContain("opaque");
  });

  it("help(unknown) names the grants that do exist", async () => {
    const stub = host();
    const result = await stub.replEvalWith(["weather"], uniqueSession(), 'help("nope")');
    expect(result.error).toBeUndefined();
    const text = result.value as string;
    expect(text).toContain('No capability named "nope"');
    expect(text).toContain("weather");
  });

  it("committed help() replays from its snapshot after revocation and restart", async () => {
    const stub = host();
    const session = uniqueSession();

    const first = await stub.replEvalWith(
      ["weather"],
      session,
      'const w = help("weather"); w.includes("get(city)")',
    );
    expect(first.error).toBeUndefined();
    expect(first.value).toBe(true);

    // Revoke everything (attach with no grants) across a restart. Cell 1
    // must replay against its recorded shape snapshot — no divergence —
    // while the new cell's help() reflects the now-empty attachment.
    await stub.restart();
    const second = await stub.replEval(session, 'w.length > 0 && !help().includes("weather")');
    expect(second.error).toBeUndefined();
    expect(second.value).toBe(true);
  });
});

describe("js tool definition (end to end)", () => {
  it("describes its grants and evaluates in real durable sessions", async () => {
    const stub = host();

    const description = await stub.jsToolDescription(["weather"]);
    expect(description).toContain('session "main"');
    expect(description).toContain("weather (Weather lookups)");

    // Default session: state persists across calls and grants work.
    const first = await stub.jsToolRun(
      ["weather"],
      'const t = (await weather.get("oslo")).temp; t',
    );
    expect(first.error).toBeUndefined();
    expect(first.value).toBe(21.5);
    const second = await stub.jsToolRun(["weather"], "t * 2");
    expect(second.error).toBeUndefined();
    expect(second.value).toBe(43);
    expect(await stub.counts()).toEqual({ "weather.get": 1 });

    // A named session is its own state.
    const other = await stub.jsToolRun(["weather"], "typeof t", "scratch");
    expect(other.value).toBe("undefined");
    expect(other.executionCount).toBe(1);
  });
});

describe("REPL emit()", () => {
  it("delivers emitted values in order, structured plus rendered", async () => {
    const stub = host();
    const result = await stub.replEval(
      uniqueSession(),
      'emit(1); emit("two"); console.log("between"); emit({ d: new Date(5) }); "done"',
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("done");
    expect(result.results).toHaveLength(3);
    expect(result.results[0].value).toBe(1);
    expect(result.results[1].value).toBe("two");
    const emitted = result.results[2].value as { d: Date };
    expect(emitted.d).toBeInstanceOf(Date);
    expect(emitted.d.getTime()).toBe(5);
    for (const entry of result.results) expect(entry.text.length).toBeGreaterThan(0);
    expect(result.logs.entries).toEqual([{ level: "log", text: "between" }]);
  });

  it("returns the emitted value for inline use", async () => {
    const stub = host();
    const result = await stub.replEval(uniqueSession(), "const r = emit(7); r + 1");
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(8);
  });

  it("ships unclonable emits as rendering only", async () => {
    const stub = host();
    const result = await stub.replEval(uniqueSession(), "emit(() => 1); 0");
    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);
    expect("value" in result.results[0]).toBe(false);
    expect(result.results[0].text).toContain("Function");
  });

  it("ships capability handles as rendering only", async () => {
    const stub = host();
    const result = await stub.replEvalWith(["weather"], uniqueSession(), 'emit(weather); "ok"');
    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);
    expect("value" in result.results[0]).toBe(false);
    expect(result.results[0].text).toContain("capability handle");
  });

  it("omits oversized structured values and says where to put them", async () => {
    const stub = host();
    const result = await stub.replEval(uniqueSession(), 'emit("x".repeat(300000)); "ok"');
    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);
    const entry = result.results[0];
    expect("value" in entry).toBe(false);
    expect(entry.text).toContain("omitted");
    expect(entry.text).toContain("workspace file");
    expect(entry.text.length).toBeLessThan(10_000);
  });

  it("suppresses replayed cells' emits, live and across restart", async () => {
    const stub = host();
    const session = uniqueSession();

    const first = await stub.replEval(session, 'emit("a"); 1');
    expect(first.results).toHaveLength(1);

    const second = await stub.replEval(session, "2");
    expect(second.error).toBeUndefined();
    expect(second.results).toHaveLength(0);

    await stub.restart();
    const third = await stub.replEval(session, "3");
    expect(third.error).toBeUndefined();
    expect(third.results).toHaveLength(0);
    expect(third.executionCount).toBe(3);
  });

  it("delivers emits from a failing cell without committing it", async () => {
    const stub = host();
    const session = uniqueSession();

    const failed = await stub.replEval(session, 'emit("before"); throw new Error("boom")');
    expect(failed.error?.message).toBe("boom");
    expect(failed.results).toHaveLength(1);
    expect(failed.results[0].value).toBe("before");

    const after = await stub.replEval(session, '"after"');
    expect(after.executionCount).toBe(failed.executionCount);
  });

  it("throws past the per-cell emit cap instead of dropping silently", async () => {
    const stub = host();
    const session = uniqueSession();

    const failed = await stub.replEval(session, "for (let i = 0; i < 1001; i++) emit(i);");
    expect(failed.error?.message).toContain("1000");
    expect(failed.error?.message).toContain("emit");

    const after = await stub.replEval(session, '"after"');
    expect(after.error).toBeUndefined();
    expect(after.executionCount).toBe(failed.executionCount);
  });
});
