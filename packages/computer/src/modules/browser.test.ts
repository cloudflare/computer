import { describe, expect, it } from "vitest";

import { parseModules } from "../backends/codemode/module-graph";
import {
  type CodemodeModule,
  codemodeModuleDefinition,
  type WorkspaceModuleScope,
  type WorkspaceModuleScopeEnd,
} from "../runtime/codemode-module";
import { isUnsafeToRepeat } from "../runtime/replay-safety";
import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFunction,
  WorkspaceModuleHost,
  WorkspaceRuntimePendingCall,
} from "../runtime/types";
import {
  type BrowserModuleSession,
  type BrowserModuleSource,
  createBrowserModule,
} from "./browser";

// A stand-in for an agents `Browser`, shaped like the parts the module
// uses. `busy` makes every lock wait until its signal aborts; `gate`
// makes it wait until the gate opens.
class FakeBrowser implements BrowserModuleSource {
  readonly sessions: FakeSession[] = [];
  busy = false;
  gate: Promise<void> | undefined;
  waitedForLockMs = 0;
  notices: string[] = [];
  readonly calls: { name: string; input: unknown }[] = [];
  readonly functionNames: string[];

  constructor(functionNames = ["cdp", "attachToTarget", "spec", "getDebugLog", "clearDebugLog"]) {
    this.functionNames = functionNames;
  }

  functionDocs() {
    return {
      functions: "- `browser.cdp({ method })` sends a CDP command.",
      rules: ["The browser persists between runs."],
    };
  }

  session(options: { scope: string; lock?: boolean }): FakeSession {
    const session = new FakeSession(this, options);
    this.sessions.push(session);
    return session;
  }
}

class FakeSession implements BrowserModuleSession {
  closed = false;
  locked = false;
  readonly functions: Readonly<Record<string, (input: unknown) => Promise<unknown>>>;

  constructor(
    private readonly browser: FakeBrowser,
    readonly options: { scope: string; lock?: boolean },
  ) {
    this.functions = Object.fromEntries(
      browser.functionNames.map((name) => [
        name,
        async (input: unknown) => {
          browser.calls.push({ name, input });
          return { name };
        },
      ]),
    );
  }

  get waitedForLockMs() {
    return this.browser.waitedForLockMs;
  }

  lock({ signal }: { signal?: AbortSignal }): Promise<void> {
    const { gate } = this.browser;
    if (gate !== undefined) {
      return gate.then(() => {
        this.locked = true;
      });
    }
    if (!this.browser.busy) {
      this.locked = true;
      return Promise.resolve();
    }
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }

  async close() {
    this.closed = true;
    return this.locked ? { notices: this.browser.notices } : undefined;
  }
}

// `pending` is read on every call, so a test can change it between checks.
function hostWith(pending: Partial<WorkspaceRuntimePendingCall>[] = []): WorkspaceModuleHost {
  // SAFETY: The module only reads `runtime.pending()` from its host.
  return {
    runtime: { pending: async () => [...pending] as WorkspaceRuntimePendingCall[] },
  } as unknown as WorkspaceModuleHost;
}

function pausedEnd(): WorkspaceModuleScopeEnd {
  return { reason: "paused", signal: new AbortController().signal, deadline: Date.now() + 60_000 };
}

function runScope(
  overrides: Partial<WorkspaceModuleScope> = {},
): WorkspaceModuleScope & { abort: AbortController } {
  const abort = new AbortController();
  return { id: "run-1", metadata: {}, signal: abort.signal, abort, ...overrides };
}

function callContext(
  access: WorkspaceModuleCallContext["access"] = "read-write",
): WorkspaceModuleCallContext {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    access,
    callId: "test-call",
    execution: { id: "run-1", metadata: {} },
    interrupt: () => Promise.reject(new Error("not used")),
    resolvePath: async (path) => path,
  };
}

function terminalEnd(): WorkspaceModuleScopeEnd & { logged: string[] } {
  const logged: string[] = [];
  return {
    reason: "completed",
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    log: (text) => logged.push(text),
    logged,
  };
}

// The session `start` opened, after the one read for the export names.
function runSession(browser: FakeBrowser): FakeSession {
  const session = browser.sessions.at(-1);
  if (session === undefined || session === browser.sessions[0]) throw new Error("no run session");
  return session;
}

// What #293's start(run, host) gave: start the module's scoped
// "session" context for one scope, and call functions with it in ctx.
async function startScope(
  module: CodemodeModule,
  run: WorkspaceModuleScope,
  host: WorkspaceModuleHost,
) {
  const definition = codemodeModuleDefinition(module);
  const context = definition?.contexts.find((item) => item.scoped && item.name === "session");
  if (definition === undefined || context === undefined)
    throw new Error("no scoped session context");
  const create = context.create as unknown as (
    run: WorkspaceModuleScope,
    host: WorkspaceModuleHost,
  ) => Promise<unknown>;
  const session = await create(run, host);
  const functions: Record<string, WorkspaceModuleFunction> = {};
  for (const [name, fn] of Object.entries(definition.functions)) {
    functions[name] = (args, ctx) =>
      fn(args, { ...ctx, session: Promise.resolve(session) } as WorkspaceModuleCallContext);
  }
  const dispose = context.dispose as unknown as (
    value: unknown,
    end: WorkspaceModuleScopeEnd,
  ) => Promise<void>;
  return { functions, close: (end: WorkspaceModuleScopeEnd) => dispose(session, end) };
}

describe("createBrowserModule", () => {
  it("exports the browser's functions and describes them with the Workspace rules", () => {
    const browser = new FakeBrowser([
      "cdp",
      "attachToTarget",
      "spec",
      "getDebugLog",
      "clearDebugLog",
      "listHosts",
    ]);
    const module = createBrowserModule({ browser });

    expect(module.exports).toEqual([
      "cdp",
      "attachToTarget",
      "spec",
      "getDebugLog",
      "clearDebugLog",
      "listHosts",
    ]);
    // Reading the names opens no locking session.
    expect(browser.sessions.map((session) => session.options.lock)).toEqual([undefined]);
    expect(module.description).toContain("- `browser.cdp({ method })` sends a CDP command.");
    expect(module.description).toContain("- The browser persists between runs.");
    expect(module.description).toContain('import * as browser from "codemode:browser"');
    expect(module.description).toContain("written to stderr after the run ends");
    expect(module.description).toContain("open the file with `read`");
    expect(module.description).toContain("about eight screenshots per run");
    expect(module.description).toContain("Target.createTarget");
    expect(module.description).toContain("Don't call the browser tool from code");
    // The backend lists it under its specifier, with its lines indented under that bullet.
    expect(parseModules({ "codemode:browser": module }).description).toContain(
      "- `codemode:browser`: A persistent Chrome browser, driven over the Chrome DevTools Protocol (CDP). It keeps its tabs, cookies and logins between runs.\n\n  - `browser.cdp({ method })`",
    );
  });

  it("names the specifiers it's given in its description", () => {
    const module = createBrowserModule({
      browser: new FakeBrowser(["cdp"]),
      specifier: "agent:browser",
      toolsSpecifier: "agent:tools",
    });

    expect(module.description).toContain('import * as browser from "agent:browser"');
    expect(module.description).toContain("through `agent:tools`");
    expect(module.description).not.toContain("codemode:");
    expect(parseModules({ "agent:browser": module }, "agent").description).toContain(
      "- `agent:browser`: A persistent Chrome browser",
    );
  });

  it('drives the "shared" browser scope by default, a string, or the one a function picks', async () => {
    const browser = new FakeBrowser();
    await startScope(createBrowserModule({ browser }), runScope(), hostWith());
    expect(runSession(browser).options).toEqual({ scope: "shared", lock: true });

    await startScope(createBrowserModule({ browser, scope: "team" }), runScope(), hostWith());
    expect(runSession(browser).options.scope).toBe("team");

    const seen: unknown[] = [];
    await startScope(
      createBrowserModule({
        browser,
        scope: (execution) => {
          seen.push(execution);
          return `conversation:${execution.metadata.conversation}`;
        },
      }),
      runScope({ metadata: { conversation: "7" } }),
      hostWith(),
    );
    expect(runSession(browser).options.scope).toBe("conversation:7");
    expect(seen).toEqual([{ id: "run-1", metadata: { conversation: "7" } }]);
  });

  it("rejects an empty browser scope", async () => {
    const browser = new FakeBrowser();
    expect(() => createBrowserModule({ browser, scope: "" })).toThrow(/scope must not be empty/);

    const module = createBrowserModule({ browser, scope: () => "" });
    await expect(startScope(module, runScope(), hostWith())).rejects.toThrow(
      /scope function returned "" for run run-1/,
    );
  });

  it("fails at once when a run that browsed and is waiting for a person holds the browser scope", async () => {
    const browser = new FakeBrowser();
    const module = createBrowserModule({
      browser,
      scope: ({ metadata }) => {
        if (metadata.conversation === undefined) throw new Error("no conversation");
        return `conversation:${metadata.conversation}`;
      },
    });
    const run0 = runScope({ id: "run-0", metadata: { conversation: "7" } });
    const held = await startScope(module, run0, hostWith());
    await held.close(pausedEnd());
    const run = runScope({ metadata: { conversation: "7" } });
    const sessions = browser.sessions.length;

    await expect(
      startScope(
        module,
        run,
        hostWith([{ id: "run-0", metadata: { conversation: "7" }, since: 0 }]),
      ),
    ).rejects.toThrow(/held by a run that's waiting for a person \(run run-0\)/);
    expect(browser.sessions).toHaveLength(sessions);

    // A waiting run that never browsed, and the run itself, don't hold it.
    await startScope(
      module,
      run,
      hostWith([
        { id: "run-9", metadata: { conversation: "7" }, since: 0 },
        { id: "run-1", metadata: { conversation: "7" }, since: 0 },
      ]),
    );
    expect(runSession(browser).options.scope).toBe("conversation:7");
  });

  it("doesn't count a run that browsed once it has ended", async () => {
    const browser = new FakeBrowser();
    const module = createBrowserModule({ browser });
    const run0 = await startScope(module, runScope({ id: "run-0" }), hostWith());
    await run0.close(terminalEnd());

    await startScope(module, runScope(), hostWith([{ id: "run-0", metadata: {}, since: 0 }]));
    expect(runSession(browser).locked).toBe(true);
  });

  it("doesn't count a wait that started after the run's session closed", async () => {
    const browser = new FakeBrowser();
    const module = createBrowserModule({ browser });
    const run0 = await startScope(module, runScope({ id: "run-0" }), hostWith());
    await run0.close(pausedEnd());

    // run-0 resumed, ended without browsing again, and a new run-0 is
    // waiting; or run-0 itself is waiting again from a scope that didn't
    // browse. Either way the wait began after the session closed.
    const later = Date.now() + 1_000;
    await startScope(module, runScope(), hostWith([{ id: "run-0", metadata: {}, since: later }]));
    expect(runSession(browser).locked).toBe(true);
  });

  it("drops a claim once its run is no longer waiting", async () => {
    const browser = new FakeBrowser();
    const module = createBrowserModule({ browser });
    const run0 = await startScope(module, runScope({ id: "run-0" }), hostWith());
    await run0.close(pausedEnd());

    // A check while run-0 isn't waiting forgets it, so a wait from an
    // earlier time no longer holds the scope.
    await startScope(module, runScope({ id: "run-1" }), hostWith());
    await startScope(
      module,
      runScope({ id: "run-2" }),
      hostWith([{ id: "run-0", metadata: {}, since: 0 }]),
    );
    expect(runSession(browser).locked).toBe(true);
  });

  it("checks again once it has its turn, in case the run ahead paused meanwhile", async () => {
    const browser = new FakeBrowser();
    const module = createBrowserModule({ browser });
    const run0 = await startScope(module, runScope({ id: "run-0" }), hostWith());

    let open!: () => void;
    browser.gate = new Promise((resolve) => (open = resolve));
    const pending: Partial<WorkspaceRuntimePendingCall>[] = [];
    const queued = startScope(module, runScope(), hostWith(pending));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // run-0 marks itself waiting, then releases the lock.
    pending.push({ id: "run-0", metadata: {}, since: 0 });
    await run0.close(pausedEnd());
    open();

    await expect(queued).rejects.toThrow(/waiting for a person \(run run-0\)/);
    expect(runSession(browser).closed).toBe(true);
  });

  it("gives up waiting for its turn with its own message, and closes the session", async () => {
    const browser = new FakeBrowser();
    browser.busy = true;
    const module = createBrowserModule({ browser, lockTimeoutMs: 10 });

    await expect(startScope(module, runScope(), hostWith())).rejects.toThrow(
      /gave up waiting for the browser after 0s: other runs in browser scope "shared" were using it/,
    );
    expect(runSession(browser).closed).toBe(true);
  });

  it("stops waiting with the run's own reason when the run is cancelled", async () => {
    const browser = new FakeBrowser();
    browser.busy = true;
    const run = runScope();
    const started = startScope(createBrowserModule({ browser }), run, hostWith());
    await Promise.resolve();
    run.abort.abort(new Error("cancelled"));

    await expect(started).rejects.toThrow("cancelled");
    expect(runSession(browser).closed).toBe(true);
  });

  it("passes one input object to the session's functions and marks cdp unsafe to repeat", async () => {
    const browser = new FakeBrowser();
    const run = runScope();
    const module = createBrowserModule({ browser });
    const { functions } = await startScope(module, run, hostWith());

    expect(Object.keys(functions)).toEqual(module.exports);
    await expect(functions.cdp?.([{ method: "Page.enable" }], callContext())).resolves.toEqual({
      name: "cdp",
    });
    await functions.spec?.([], callContext());
    expect(browser.calls).toEqual([
      { name: "cdp", input: { method: "Page.enable" } },
      { name: "spec", input: undefined },
    ]);
    await expect(functions.cdp?.([{}, {}], callContext())).rejects.toThrow(
      /takes one input object/,
    );

    const exported = codemodeModuleDefinition(module)?.functions ?? {};
    expect(isUnsafeToRepeat(exported.cdp)).toBe(true);
    for (const name of ["attachToTarget", "spec", "getDebugLog", "clearDebugLog"]) {
      expect(isUnsafeToRepeat(exported[name])).toBe(false);
    }

    expect(browser.calls).toHaveLength(2);
  });

  it("refuses every function on a read-only backend, before opening a session", async () => {
    const browser = new FakeBrowser();
    const module = createBrowserModule({ browser });
    const exported = codemodeModuleDefinition(module)?.functions ?? {};
    // No ctx.session: reading it would throw, so the check comes first.
    for (const name of module.exports) {
      await expect(exported[name]?.([{}], callContext("read"))).rejects.toThrow(
        `codemode:browser ${name} requires Workspace write access.`,
      );
    }
    expect(browser.sessions).toHaveLength(1);
  });

  it("closes the session when the run pauses, without logging", async () => {
    const browser = new FakeBrowser();
    browser.notices = ["The browser was restarted."];
    const instance = await startScope(createBrowserModule({ browser }), runScope(), hostWith());

    await instance.close({
      reason: "paused",
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
    });
    expect(runSession(browser).closed).toBe(true);
  });

  it("logs the session's notices and a noticeable wait when the run ends", async () => {
    const browser = new FakeBrowser();
    browser.notices = ["The browser was restarted.", "New tabs opened by the page: []"];
    browser.waitedForLockMs = 2_400;
    const instance = await startScope(createBrowserModule({ browser }), runScope(), hostWith());

    const end = terminalEnd();
    await instance.close(end);
    expect(runSession(browser).closed).toBe(true);
    expect(end.logged).toEqual([
      "The browser was restarted.\n",
      "New tabs opened by the page: []\n",
      "This run waited 2s for its turn with the browser, while other runs in its browser scope used it.\n",
    ]);
  });

  it("doesn't mention a short wait", async () => {
    const browser = new FakeBrowser();
    browser.waitedForLockMs = 300;
    const instance = await startScope(createBrowserModule({ browser }), runScope(), hostWith());

    const end = terminalEnd();
    await instance.close(end);
    expect(end.logged).toEqual([]);
  });
});
