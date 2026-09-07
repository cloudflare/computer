// Durable REPL sessions — capability behavior tests.
//
// Runs against real workerd with a real worker_loaders binding. The core
// discipline under test: capability calls execute live exactly once, are
// recorded in the session log, and replay — including across a simulated
// Durable Object eviction — answers every call from the log with ZERO live
// calls. Counters live on the test DO so restarts can't reset them.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ReplHostDO } from "./repl-worker.js";

let sessionCounter = 0;

function uniqueSession(): string {
  sessionCounter += 1;
  return `cap-session-${sessionCounter}`;
}

function host() {
  const id = env.HOST.newUniqueId();
  return env.HOST.get(id);
}

describe("REPL capabilities", () => {
  it("serves replayed capability calls from the log with zero live calls", async () => {
    const stub = host();
    const session = uniqueSession();

    // Live cell: the call really fires, and the result is a real value —
    // including a Date that must survive the log round-trip.
    const first = await stub.replEvalWith(
      ["weather"],
      session,
      `const report = await weather.get("london");
       report.temp`,
    );
    expect(first.error).toBeUndefined();
    expect(first.value).toBe(21.5);
    expect(await stub.counts()).toEqual({ "weather.get": 1 });

    // Second eval replays cell 1 — the recorded result must be served, not
    // re-fetched, and the restored value must be the real thing (Date and
    // all), not a JSON shadow.
    const second = await stub.replEvalWith(
      ["weather"],
      session,
      `[report.city, report.asOf instanceof Date, report.asOf.getTime()]`,
    );
    expect(second.error).toBeUndefined();
    expect(second.value).toEqual(["london", true, 1735732800000]);
    expect(await stub.counts()).toEqual({ "weather.get": 1 });

    // Eviction: in-memory session state is gone, the log survives. Replay
    // rebuilds the same state, still without touching the capability.
    await stub.restart();
    const third = await stub.replEvalWith(["weather"], session, `report.temp * 2`);
    expect(third.error).toBeUndefined();
    expect(third.value).toBe(43);
    expect(await stub.counts()).toEqual({ "weather.get": 1 });
  });

  it("grants bare functions as callables", async () => {
    const stub = host();
    const session = uniqueSession();

    const first = await stub.replEvalWith(
      ["sendEmail"],
      session,
      `const receipt = await sendEmail("a@example.com", "Hello");
       receipt`,
    );
    expect(first.error).toBeUndefined();
    expect(first.value).toEqual({
      queued: true,
      id: "msg-1",
      to: "a@example.com",
      subject: "Hello",
    });
    expect(await stub.counts()).toEqual({ sendEmail: 1 });

    await stub.restart();
    const second = await stub.replEvalWith(["sendEmail"], session, `receipt.id`);
    expect(second.value).toBe("msg-1");
    expect(await stub.counts()).toEqual({ sendEmail: 1 });
  });

  it("chains returned handles across cells and replays them with zero live calls", async () => {
    const stub = host();
    const session = uniqueSession();

    // A class-instance capability returning a class-instance handle.
    const first = await stub.replEvalWith(
      ["browser"],
      session,
      `const tab = await browser.newTab("https://example.com");
       (await tab.read()).title`,
    );
    expect(first.error).toBeUndefined();
    expect(first.value).toBe("Title of https://example.com");

    const second = await stub.replEvalWith(
      ["browser"],
      session,
      `const outcome = await tab.click("#buy");
       outcome`,
    );
    expect(second.error).toBeUndefined();
    expect(second.value).toEqual({ clicked: "#buy" });
    expect(await stub.counts()).toEqual({
      "browser.newTab": 1,
      "tab.read": 1,
      "tab.click": 1,
    });

    // Across an eviction, both cells (and the handle chain inside them)
    // replay purely from the log.
    await stub.restart();
    const third = await stub.replEvalWith(["browser"], session, `outcome.clicked`);
    expect(third.error).toBeUndefined();
    expect(third.value).toBe("#buy");
    expect(await stub.counts()).toEqual({
      "browser.newTab": 1,
      "tab.read": 1,
      "tab.click": 1,
    });
  });

  it("answers new calls on dead handles with a stale-lease error carrying the recipe", async () => {
    const stub = host();
    const session = uniqueSession();

    await stub.replEvalWith(
      ["browser"],
      session,
      `const tab = await browser.newTab("https://example.com");
       await tab.read()`,
    );

    // Eviction kills the live tab object; the replayed proxy still exists.
    await stub.restart();
    const stale = await stub.replEvalWith(["browser"], session, `await tab.click("#buy")`);
    expect(stale.error?.kind).toBe("stale-lease");
    expect(stale.error?.name).toBe("StaleLeaseError");
    // The error carries the full acquisition recipe — how to get it back.
    expect(stale.error?.message).toContain('browser.newTab("https://example.com")');
    expect(await stub.counts()).toEqual({ "browser.newTab": 1, "tab.read": 1 });

    // The failed cell was not committed; re-acquiring works.
    const recover = await stub.replEvalWith(
      ["browser"],
      session,
      `const tab2 = await browser.newTab("https://example.com");
       (await tab2.click("#buy")).clicked`,
    );
    expect(recover.error).toBeUndefined();
    expect(recover.value).toBe("#buy");
    expect(await stub.counts()).toEqual({
      "browser.newTab": 2,
      "tab.read": 1,
      "tab.click": 1,
    });
  });

  it("cuts handles when the root they descend from is revoked", async () => {
    const stub = host();
    const session = uniqueSession();

    await stub.replEvalWith(
      ["browser"],
      session,
      `const tab = await browser.newTab("https://example.com");
       await tab.read()`,
    );

    // Same host (no restart) — the handle is alive — but the browser
    // grant is gone, so everything descending from it is too.
    const revoked = await stub.replEvalWith([], session, `await tab.click("#buy")`);
    expect(revoked.error?.kind).toBe("not-granted");
    expect(revoked.error?.message).toContain('descends from "browser"');
    expect(await stub.counts()).toEqual({ "browser.newTab": 1, "tab.read": 1 });

    // Re-granting the root restores the very same handle.
    const restored = await stub.replEvalWith(["browser"], session, `await tab.click("#buy")`);
    expect(restored.error).toBeUndefined();
    expect(restored.value).toEqual({ clicked: "#buy" });
  });

  it("replays recorded capability errors without re-firing the call", async () => {
    const stub = host();
    const session = uniqueSession();

    // The cell catches the failure and commits — so the error itself is
    // now part of the log and must replay identically.
    const first = await stub.replEvalWith(
      ["weather"],
      session,
      `let caught = null;
       try { await weather.flaky(); } catch (error) { caught = error.message; }
       caught`,
    );
    expect(first.error).toBeUndefined();
    expect(first.value).toBe("boom 1");
    expect(await stub.counts()).toEqual({ "weather.flaky": 1 });

    await stub.restart();
    const second = await stub.replEvalWith(["weather"], session, `caught`);
    expect(second.value).toBe("boom 1");
    // Replay served the recorded error; the flaky call never re-fired.
    expect(await stub.counts()).toEqual({ "weather.flaky": 1 });
  });

  it("fails loudly when recorded capability args no longer match the code", async () => {
    const stub = host();
    const session = uniqueSession();

    await stub.replEvalWith(["weather"], session, `await weather.get("london")`);
    await stub.corruptCapCallArgs(session, "london", "paris");
    await stub.restart();

    const diverged = await stub.replEvalWith(["weather"], session, `1 + 1`);
    expect(diverged.error?.kind).toBe("replay-divergence");
    expect(diverged.error?.message).toContain("capability call");
  });

  it("snapshots granted data per cell: replay sees original values, new cells see current", async () => {
    const stub = host();
    const session = uniqueSession();

    const first = await stub.replEvalWith(["configV1"], session, `const url1 = config.apiUrl; url1`);
    expect(first.value).toBe("https://v1.example");

    // Re-attach with different data under the same name: the old binding
    // (from cell 1's snapshot) and the new attachment coexist.
    const second = await stub.replEvalWith(
      ["configV2"],
      session,
      `[url1, config.apiUrl, config.retries]`,
    );
    expect(second.value).toEqual(["https://v1.example", "https://v2.example", 5]);

    // After eviction both cells replay against their own recorded grants.
    await stub.restart();
    const third = await stub.replEvalWith(["configV2"], session, `[url1, config.apiUrl]`);
    expect(third.value).toEqual(["https://v1.example", "https://v2.example"]);
  });

  it("rejects calls to revoked capabilities while old cells keep replaying", async () => {
    const stub = host();
    const session = uniqueSession();

    const first = await stub.replEvalWith(
      ["weather"],
      session,
      `const w = weather;
       const t = (await weather.get("oslo")).temp;
       t`,
    );
    expect(first.value).toBe(21.5);

    // Attach WITHOUT weather: cell 1 still replays fine (zero live calls).
    const second = await stub.replEvalWith([], session, `t * 2`);
    expect(second.error).toBeUndefined();
    expect(second.value).toBe(43);
    expect(await stub.counts()).toEqual({ "weather.get": 1 });

    // The global is gone for new code…
    const third = await stub.replEvalWith([], session, `typeof weather`);
    expect(third.value).toBe("undefined");

    // …and a kept alias gets the structured answer, not a dead stub.
    const fourth = await stub.replEvalWith([], session, `await w.get("oslo")`);
    expect(fourth.error?.kind).toBe("not-granted");
    expect(fourth.error?.message).toContain('"weather" is not granted');
    expect(await stub.counts()).toEqual({ "weather.get": 1 });
  });

  it("denies ambient fetch with an error that names the fix", async () => {
    const stub = host();
    const session = uniqueSession();
    const result = await stub.replEvalWith([], session, `await fetch("https://x.example/")`);
    expect(result.error?.message).toContain("No ambient network");
    expect(result.error?.message).toContain("fetchCapability");

    // Granting a capability AS `fetch` shadows the guidance; revoking it
    // restores the guidance instead of leaving `fetch` deleted.
    const granted = await stub.replEvalWith(["fetchBlocked"], session, `typeof fetch`);
    expect(granted.value).toBe("function");
    const revoked = await stub.replEvalWith([], session, `await fetch("https://x.example/")`);
    expect(revoked.error?.message).toContain("No ambient network");
  });

  it("enforces the fetch capability allowlist", async () => {
    const stub = host();
    const session = uniqueSession();

    const denied = await stub.replEvalWith(
      ["fetchBlocked"],
      session,
      `await fetch("https://evil.example/steal")`,
    );
    expect(denied.error?.name).toBe("EgressDeniedError");
    expect(denied.error?.message).toContain("evil.example");
    expect(denied.error?.message).toContain("allowed.example");

    // The failed cell did not commit; the session is still usable.
    const next = await stub.replEvalWith(["fetchBlocked"], session, `1 + 1`);
    expect(next.value).toBe(2);
    expect(next.executionCount).toBe(1);
  });

  it("routes granted fetch through the gateway and replays responses without refetching", async () => {
    const stub = host();
    const session = uniqueSession();

    const first = await stub.replEvalWith(
      ["fetchSelf"],
      session,
      `const res = await fetch("https://service.internal/hello");
       const body = await res.json();
       [res.status, res.ok, body.ok, body.path]`,
    );
    expect(first.error).toBeUndefined();
    expect(first.value).toEqual([200, true, true, "/hello"]);
    expect(await stub.counts()).toEqual({ "gateway.fetch": 1 });

    await stub.restart();
    const second = await stub.replEvalWith(["fetchSelf"], session, `body.path`);
    expect(second.value).toBe("/hello");
    expect(await stub.counts()).toEqual({ "gateway.fetch": 1 });
  });

  it("records filesystem effects once and never re-fires them on replay", async () => {
    const stub = host();
    const session = uniqueSession();

    const first = await stub.replEvalWith(
      ["fs"],
      session,
      `await fs.mkdir("/notes");
       await fs.writeFile("/notes/log.txt", "alpha");
       await fs.readFile("/notes/log.txt")`,
    );
    expect(first.error).toBeUndefined();
    expect(first.value).toBe("alpha");
    expect(await stub.counts()).toMatchObject({ "fs.writeFile": 1, "fs.readFile": 1 });

    const second = await stub.replEvalWith(
      ["fs"],
      session,
      `const current = await fs.readFile("/notes/log.txt");
       await fs.writeFile("/notes/log.txt", current + "+beta");
       await fs.readFile("/notes/log.txt")`,
    );
    expect(second.value).toBe("alpha+beta");
    expect(await stub.counts()).toMatchObject({ "fs.writeFile": 2, "fs.readFile": 3 });

    // Replay after eviction re-fires nothing: same content, same counters
    // (+1 read for the new cell's own live read).
    await stub.restart();
    const third = await stub.replEvalWith(["fs"], session, `await fs.readFile("/notes/log.txt")`);
    expect(third.value).toBe("alpha+beta");
    expect(await stub.counts()).toMatchObject({ "fs.writeFile": 2, "fs.readFile": 4 });
  });

  it("rejects oversized capability results without committing or truncating", async () => {
    const stub = host();
    const session = uniqueSession();

    const oversized = await stub.replEvalWith(
      ["big"],
      session,
      `await big.blob(5000)`,
      undefined,
      { maxEffectBytes: 1024 },
    );
    expect(oversized.error?.kind).toBe("oversized-result");
    expect(oversized.error?.name).toBe("OversizedResultError");
    expect(oversized.error?.message).toContain("1024");

    // Nothing was committed — and small results still work.
    const next = await stub.replEvalWith(["big"], session, `await big.blob(3)`);
    expect(next.value).toBe("xxx");
    expect(next.executionCount).toBe(1);
  });

  it("exposes a safe proxy surface: awaitable, symbol-blind, rendered as a handle", async () => {
    const stub = host();
    const session = uniqueSession();

    // `await cap` must yield the proxy itself (the `then` guard), symbol
    // properties must read as undefined, and a capability as a cell's
    // value must render as a handle reference, not structured-clone.
    const first = await stub.replEvalWith(
      ["weather"],
      session,
      `const w = await weather;
       const viaAwait = (await w.get("lisbon")).city;
       const symbolProp = typeof weather[Symbol.iterator];
       [viaAwait, symbolProp]`,
    );
    expect(first.error).toBeUndefined();
    expect(first.value).toEqual(["lisbon", "undefined"]);
    expect(await stub.counts()).toEqual({ "weather.get": 1 });

    const second = await stub.replEvalWith(["weather"], session, `weather`);
    expect(second.error).toBeUndefined();
    expect(second.value).toBeUndefined();
    expect(second.results?.[0]?.text).toContain("capability handle");
    expect(second.results?.[0]?.text).toContain("weather");
  });

  it("supports nested capability objects (children) beside plain data", async () => {
    const stub = host();
    const session = uniqueSession();

    const first = await stub.replEvalWith(
      ["api"],
      session,
      `const names = await api.users.list();
       [api.version, names]`,
    );
    expect(first.error).toBeUndefined();
    expect(first.value).toEqual(["2.0", ["ada", "grace"]]);
    expect(await stub.counts()).toEqual({ "api.users.list": 1 });

    // Replay across eviction: the nested call is served from the log.
    await stub.restart();
    const second = await stub.replEvalWith(["api"], session, `[api.version, names.length]`);
    expect(second.error).toBeUndefined();
    expect(second.value).toEqual(["2.0", 2]);
    expect(await stub.counts()).toEqual({ "api.users.list": 1 });
  });

  it("treats every property of an unreflectable stub as a method (opaque surface)", async () => {
    const stub = host();
    const session = uniqueSession();

    const first = await stub.replEvalWith(["stub"], session, `await stub.ping()`);
    expect(first.error).toBeUndefined();
    expect(first.value).toBe("pong");
    expect(await stub.counts()).toEqual({ "stub.ping": 1 });

    // A property the target never materializes: the live call fails with
    // the recipe-qualified name, the cell can catch it, and the caught
    // error is recorded — so the cell commits and replays identically.
    const second = await stub.replEvalWith(
      ["stub"],
      session,
      `let caught;
       try { await stub.missing(); } catch (e) { caught = e.message; }
       caught`,
    );
    expect(second.error).toBeUndefined();
    expect(String(second.value)).toContain("stub.missing is not a function");

    await stub.restart();
    const third = await stub.replEvalWith(["stub"], session, `[typeof caught, await stub.ping()]`);
    expect(third.error).toBeUndefined();
    expect(third.value).toEqual(["string", "pong"]);
    expect(await stub.counts()).toEqual({ "stub.ping": 2 });
  });

  it("mints returned functions as callable handles, stale after host restart", async () => {
    const stub = host();
    const session = uniqueSession();

    const first = await stub.replEvalWith(
      ["tools"],
      session,
      `const greet = await tools.makeGreeter("Ada");
       await greet("Hello")`,
    );
    expect(first.error).toBeUndefined();
    expect(first.value).toBe("Hello, Ada!");

    // The function handle persists as a session binding and stays live.
    const second = await stub.replEvalWith(["tools"], session, `await greet("Hi")`);
    expect(second.error).toBeUndefined();
    expect(second.value).toBe("Hi, Ada!");
    expect(await stub.counts()).toEqual({ "tools.makeGreeter": 1, "tools.greet": 2 });

    // Restart kills live handles: replay still rebuilds `greet` (both prior
    // calls served from the log), but a NEW call on it is a stale lease
    // carrying the acquisition recipe.
    await stub.restart();
    const third = await stub.replEvalWith(["tools"], session, `await greet("Yo")`);
    expect(third.error?.kind).toBe("stale-lease");
    expect(third.error?.message).toContain('tools.makeGreeter("Ada")');
    expect(await stub.counts()).toEqual({ "tools.makeGreeter": 1, "tools.greet": 2 });
  });

  it("covers the whole workspaceFs surface, replayed with zero live calls", async () => {
    const stub = host();
    const session = uniqueSession();

    const first = await stub.replEvalWith(
      ["fs"],
      session,
      `await fs.mkdir("/data");
       await fs.writeFile("/data/a.txt", "alpha");
       const names = await fs.readdir("/data");
       const present = await fs.exists("/data/a.txt");
       const absent = await fs.exists("/data/nope");
       const st = await fs.stat("/data/a.txt");
       const bytes = await fs.readFileBytes("/data/a.txt");
       await fs.rm("/data/a.txt");
       const afterRm = await fs.exists("/data/a.txt");
       [names, present, absent, st.isFile, st.size, bytes instanceof Uint8Array, bytes.length, afterRm]`,
    );
    expect(first.error).toBeUndefined();
    expect(first.value).toEqual([["a.txt"], true, false, true, 5, true, 5, false]);

    const liveFsCalls = async () => {
      const counts = await stub.counts();
      return Object.entries(counts)
        .filter(([name]) => name.startsWith("fs."))
        .reduce((sum, [, n]) => sum + n, 0);
    };
    const afterLive = await liveFsCalls();
    expect(afterLive).toBeGreaterThan(0);

    // Eviction + replay: every fs effect is served from the log.
    await stub.restart();
    const second = await stub.replEvalWith(["fs"], session, `[present, absent, afterRm]`);
    expect(second.error).toBeUndefined();
    expect(second.value).toEqual([true, false, false]);
    expect(await liveFsCalls()).toBe(afterLive);
  });

  it("rejects unrecordable call arguments with the fix named", async () => {
    const stub = host();
    const session = uniqueSession();

    const bad = await stub.replEvalWith(["weather"], session, `await weather.get(() => 1)`);
    expect(bad.error?.message).toMatch(/function .*cannot be recorded|A function cannot be recorded/);
    // The call never crossed the bridge.
    expect(await stub.counts()).toEqual({});

    const next = await stub.replEvalWith(["weather"], session, `(await weather.get("rome")).city`);
    expect(next.value).toBe("rome");
    expect(next.executionCount).toBe(1);
  });
});

// Silence the unused-import lint for the DO type-only import.
export type { ReplHostDO };

// Keep runInDurableObject imported for later seams that reach into storage.
void runInDurableObject;
