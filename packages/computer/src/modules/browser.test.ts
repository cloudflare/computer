import { describe, expect, it } from "vitest";

import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleHost,
  WorkspaceRuntimeValue,
} from "../runtime/types.js";
import {
  createBrowserModule,
  type BrowserModuleOptions,
  type BrowserSession,
  type BrowserSessionOptions,
  type BrowserSessionReport,
  type BrowserSource,
} from "./browser.js";

// SAFETY: The browser module never touches the host's Git, Artifacts, or runtime.
const host = {} as WorkspaceModuleHost;

interface FakeSession extends BrowserSession {
  readonly options: BrowserSessionOptions | undefined;
  readonly calls: Array<[string, unknown]>;
  closed: number;
}

// Sessions that record their calls. The CDP behaviour behind a session is
// `agents/browser`'s, tested there; this module only routes calls to the
// run's session and closes it.
class FakeBrowser implements BrowserSource {
  readonly name = "work";
  readonly sessions: FakeSession[] = [];
  report: BrowserSessionReport | undefined = {
    restarted: false,
    newTabs: [],
    tabClosed: false,
    tabShared: false,
  };

  session(options?: BrowserSessionOptions): BrowserSession {
    const calls: Array<[string, unknown]> = [];
    const record = (name: string) => async (input?: unknown) => {
      calls.push([name, input]);
      if (name === "send" && (input as { method?: string })?.method === "Browser.close") {
        throw new Error("Browser.close is not available");
      }
      return { called: name, input: input ?? null };
    };
    const session: FakeSession = {
      options,
      calls,
      closed: 0,
      send: record("send"),
      attachToTarget: record("attachToTarget"),
      spec: record("spec"),
      getDebugLog: record("getDebugLog"),
      clearDebugLog: record("clearDebugLog"),
      close: async () => {
        session.closed += 1;
        return this.report;
      },
    };
    this.sessions.push(session);
    return session;
  }
}

function setup(options: Partial<BrowserModuleOptions> = {}) {
  const browser = new FakeBrowser();
  const module = createBrowserModule({ browser, ...options });
  const functions = module(host);
  let runs = 0;

  function context(executionId: string, logs: string[], deferred: Array<() => unknown>) {
    return {
      executionId,
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
      access: "read-write",
      resolvePath: async (path: string) => path,
      log: (text: string) => logs.push(text),
      defer: (fn: () => unknown) => deferred.push(fn),
    } satisfies WorkspaceModuleCallContext;
  }

  /** Make `calls` as one run, then run what it deferred, as the backend does. */
  async function run(calls: Array<[string, ...WorkspaceRuntimeValue[]]>) {
    const logs: string[] = [];
    const deferred: Array<() => unknown> = [];
    const ctx = context(`run-${++runs}`, logs, deferred);
    const results: unknown[] = [];
    let error: unknown;
    try {
      for (const [name, ...args] of calls) {
        results.push(await functions[name](args, ctx));
      }
    } catch (caught) {
      error = caught;
    }
    while (deferred.length > 0) await deferred.pop()?.();
    return { results, error, logs };
  }

  return { browser, module, functions, run, context };
}

describe("ws:browser", () => {
  it("exports the browser calls and describes them for a model", () => {
    const { functions, module } = setup();
    expect(Object.keys(functions).sort()).toEqual([
      "attachToTarget",
      "clearDebugLog",
      "getDebugLog",
      "send",
      "spec",
    ]);
    expect(module.description).toContain("send({ method");
    expect(module.description).toContain("standard error");
    expect(module.description).not.toContain("cdp.");
  });

  it("starts one session per run and closes it when the run ends", async () => {
    const t = setup();
    const first = await t.run([
      ["send", { method: "Page.navigate", sessionId: "active" }],
      ["attachToTarget", { targetId: "target-1" }],
      ["spec"],
      ["getDebugLog", { limit: 5 }],
      ["clearDebugLog"],
    ]);
    expect(first.error).toBeUndefined();
    expect(first.results[0]).toEqual({
      called: "send",
      input: { method: "Page.navigate", sessionId: "active" },
    });
    expect(t.browser.sessions).toHaveLength(1);
    expect(t.browser.sessions[0].calls.map(([name]) => name)).toEqual([
      "send",
      "attachToTarget",
      "spec",
      "getDebugLog",
      "clearDebugLog",
    ]);
    expect(t.browser.sessions[0].closed).toBe(1);

    await t.run([["send", { method: "Target.getTargets" }]]);
    expect(t.browser.sessions).toHaveLength(2);
    expect(t.browser.sessions[1].closed).toBe(1);
  });

  it("shares one session between a run's concurrent calls", async () => {
    const t = setup();
    const logs: string[] = [];
    const deferred: Array<() => unknown> = [];
    const ctx = t.context("parallel", logs, deferred);
    await Promise.all([
      t.functions.send([{ method: "Target.getTargets" }], ctx),
      t.functions.send([{ method: "Browser.getVersion" }], ctx),
    ]);
    expect(t.browser.sessions).toHaveLength(1);
    expect(deferred).toHaveLength(1);
  });

  it("passes the scope and screenshot limit to the session", async () => {
    const t = setup({ scope: "thread-1", maxResultBytes: 500 });
    await t.run([["spec"]]);
    expect(t.browser.sessions[0].options).toEqual({ scope: "thread-1", maxResultBytes: 500 });

    const plain = setup();
    await plain.run([["spec"]]);
    expect(plain.browser.sessions[0].options).toEqual({});
  });

  it("writes what happened to the browser to standard error", async () => {
    const t = setup();
    t.browser.report = {
      restarted: true,
      newTabs: [{ targetId: "target-3", url: "https://popup.example/" }],
      tabClosed: true,
      tabShared: true,
    };
    const { logs } = await t.run([["send", { method: "Target.getTargets" }]]);
    expect(logs).toEqual([
      expect.stringContaining("The browser was restarted before this run"),
      expect.stringContaining(
        "Another conversation using this browser is also working in your tab",
      ),
      'New tabs opened by the page: [{"targetId":"target-3","url":"https://popup.example/"}]',
    ]);

    t.browser.report = { restarted: false, newTabs: [], tabClosed: true, tabShared: false };
    const closed = await t.run([["send", { method: "Target.getTargets" }]]);
    expect(closed.logs).toEqual([
      expect.stringContaining("The tab you were working in was closed"),
    ]);
  });

  it("passes the session's errors to the code and still closes it", async () => {
    const t = setup();
    const { error } = await t.run([["send", { method: "Browser.close" }]]);
    expect(String(error)).toContain("Browser.close is not available");
    expect(t.browser.sessions[0].closed).toBe(1);
  });

  it("refuses more than one argument", async () => {
    const t = setup();
    const { error } = await t.run([["send", { method: "Page.navigate" }, "extra"]]);
    expect(String(error)).toContain("takes one options object");
  });

  it("leaves the browser alone for a run that never called it", async () => {
    const t = setup();
    const { logs } = await t.run([]);
    expect(logs).toEqual([]);
    expect(t.browser.sessions).toEqual([]);
  });
});
