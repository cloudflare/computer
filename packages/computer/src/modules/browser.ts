// `ws:browser`: a persistent Chrome browser for isolate JavaScript, over
// the Chrome DevTools Protocol.
//
//   import { send, attachToTarget } from "ws:browser";
//
// The browser belongs to the host. This module opens a session on it for
// each run and closes it when the run ends. It needs only something with a
// `name` and `session()` (see `BrowserSource`), such as `Browser` from
// `agents/browser`, so it doesn't depend on any one browser provider. The
// session does the CDP work: the "active" tab, attach handles that last
// between runs, error hints, and the report of what happened to the browser.

import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFactory,
  WorkspaceModuleFunctions,
} from "../runtime/types.js";

/** A tab a page opened on its own during a run. */
export interface BrowserNewTab {
  targetId: string;
  url?: string;
  title?: string;
}

/**
 * What happened to the browser during one run, beyond its calls' results.
 * `BrowserSession.close` resolves with it.
 */
export interface BrowserSessionReport {
  /** The browser was replaced before this run; earlier page state is gone. */
  restarted: boolean;
  /** Tabs the page opened itself (popups, `target=_blank`). */
  newTabs: BrowserNewTab[];
  /**
   * The tab this scope was working in was closed by someone else (another
   * scope, or a person in Live View), so `"active"` will be a new blank tab.
   */
  tabClosed: boolean;
  /** Another scope is working in this scope's active tab too. */
  tabShared: boolean;
}

/**
 * One run's session on the browser. `browser.session()` from
 * `agents/browser` returns one. Each method takes the single options
 * object the isolate passed, which comes from untrusted code, so the
 * session must validate it.
 */
export interface BrowserSession {
  /** Send a CDP command and resolve with its result. */
  send(input: unknown): Promise<unknown>;
  /** Make an open tab active and resolve with `{ sessionId }`. */
  attachToTarget(input: unknown): Promise<unknown>;
  /** The Chrome DevTools Protocol description the browser serves. */
  spec(): Promise<unknown>;
  /** Recent protocol traffic, newest last. */
  getDebugLog(input?: unknown): Promise<unknown>;
  /** Forget the protocol traffic recorded so far. */
  clearDebugLog(): Promise<unknown>;
  /**
   * End the session and resolve with its report, or `undefined` when it
   * never connected. The browser stays open.
   */
  close(): Promise<BrowserSessionReport | undefined>;
}

/** Options the module passes to {@link BrowserSource.session}. */
export interface BrowserSessionOptions {
  scope?: string;
  maxResultBytes?: number;
}

/**
 * The browser the module drives. `Browser` from `agents/browser` has this
 * shape.
 */
export interface BrowserSource {
  /** The browser's name. */
  readonly name: string;
  /** Start a session for one run. */
  session(options?: BrowserSessionOptions): BrowserSession;
}

/** Options for {@link createBrowserModule}. */
export interface BrowserModuleOptions {
  /** The browser to drive. */
  readonly browser: BrowserSource;
  /**
   * Who is driving, when several conversations share one browser: runs with
   * the same scope share an active tab, and each scope keeps its own.
   * Cookies and logins are shared by every scope. Defaults to the
   * browser's own default.
   */
  readonly scope?: string;
  /**
   * The largest `Page.captureScreenshot` result `send` returns, measured as
   * JSON. Defaults to the session's own limit (1,000,000 bytes for
   * `agents/browser`). Keep it under the backend's `maxCapabilityBytes`.
   */
  readonly maxResultBytes?: number;
}

const RESTARTED_NOTICE =
  "The browser was restarted before this run (it expired or was closed): earlier tabs, logins, and page state are gone. Your code ran in a fresh browser, so navigate again before relying on page state.";

const TAB_CLOSED_NOTICE =
  'The tab you were working in was closed (by another conversation using this browser, or a person). `sessionId: "active"` now opens a blank tab, so navigate again before relying on page state.';

const TAB_SHARED_NOTICE =
  "Another conversation using this browser is also working in your tab, so its page may change between your runs. Open a tab of your own with Target.createTarget if you need one.";

/**
 * Lines telling the model what happened to its browser during a run: it
 * was restarted, its tab was closed by someone else, another scope is
 * working in its tab too, or the page opened tabs.
 */
function reportLines(report: BrowserSessionReport | undefined): string[] {
  if (!report) return [];
  const lines = [
    report.restarted && RESTARTED_NOTICE,
    report.tabClosed && !report.restarted && TAB_CLOSED_NOTICE,
    report.tabShared && TAB_SHARED_NOTICE,
  ].filter((notice) => typeof notice === "string");
  if (report.newTabs.length > 0) {
    lines.push(`New tabs opened by the page: ${JSON.stringify(report.newTabs)}`);
  }
  return lines;
}

function browserRules(): string[] {
  return [
    "The browser persists between runs: tabs, cookies, and logins are still there next time. You never start or close it.",
    "If the browser was replaced (idle timeout, crash), standard error says so and earlier tabs and logins are gone. Before an action that matters (submitting a form, a purchase), check you're on the page you expect.",
    'Page-scoped commands (Page.*, Runtime.*, DOM.*, Input.*, Network.*, Emulation.*) need sessionId: "active", your tab, which is remembered between runs. Browser.* and Target.* commands take no sessionId.',
    "Other open tabs (Target.getTargets) may belong to other conversations using this browser: don't close, navigate, or attach to a tab you didn't open unless the user asks.",
    "Target.createTarget opens a tab and makes it active. To switch to another open tab, call attachToTarget({ targetId }); the sessionId it returns keeps working in later runs, while one from a raw Target.attachToTarget only works in the current run.",
    "Tabs a page opens itself (popups, target=_blank links) don't become active; standard error lists them.",
    "Runtime.evaluate: pass returnByValue: true, or objects come back as a remote reference with no value, and awaitPromise: true for async expressions. The value is at result.value. A thrown error doesn't reject: check exceptionDetails.",
    "Page.navigate returns before the page loads and doesn't throw when it fails: check errorText, then poll document.readyState with Runtime.evaluate until it is 'complete'.",
    "Pick out what you need inside Runtime.evaluate and return only that. A single send result over 1 MB (a full-page screenshot, say) fails the call.",
  ];
}

const DESCRIPTION = [
  "A persistent Chrome browser over the Chrome DevTools Protocol (CDP).",
  "- `send({ method, params?, sessionId?, timeoutMs? })` sends a CDP command and returns its result without the JSON-RPC envelope: `Page.navigate` returns `{ frameId, errorText? }`, `Runtime.evaluate` returns `{ result: { value }, exceptionDetails? }`.",
  "- `attachToTarget({ targetId })` makes an open tab active and returns `{ sessionId }`.",
  '- `spec()` returns the whole protocol (about 650 KB) as `{ domains: [{ name, commands, events, types }] }`. Filter it in code, for example `spec.domains.find((d) => d.name === "Page")`.',
  "- `getDebugLog({ limit? })` returns recent protocol traffic, for when a command fails or times out. `clearDebugLog()` clears it.",
  '- To look at the page, save a screenshot and open it with the `read` tool: `const { data } = await send({ method: "Page.captureScreenshot", sessionId: "active" }); await writeFile("/workspace/page.png", Buffer.from(data, "base64"));`, with `writeFile` from `node:fs/promises` and `Buffer` from `node:buffer`.',
  ...browserRules().map((rule) => `- ${rule}`),
].join("\n");

type BrowserFunctionName = "send" | "attachToTarget" | "spec" | "getDebugLog" | "clearDebugLog";

const BROWSER_FUNCTION_NAMES: readonly BrowserFunctionName[] = [
  "send",
  "attachToTarget",
  "spec",
  "getDebugLog",
  "clearDebugLog",
];

/**
 * Build the `ws:browser` host module over a persistent browser.
 *
 * It exports `send`, `attachToTarget`, `spec`, `getDebugLog` and
 * `clearDebugLog`. A run's first call starts a session on the browser.
 * When the run ends, the module closes the session, which saves the
 * scope's active tab, and writes what happened to the browser (a restart,
 * tabs the page opened) to standard error. The browser stays open.
 *
 * @param options - The browser, the scope to drive it in, and the size limit on screenshots.
 * @returns The module to pass as `modules["ws:browser"]`.
 */
export function createBrowserModule(options: BrowserModuleOptions): WorkspaceModuleFactory {
  const sessionOptions: BrowserSessionOptions = {
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.maxResultBytes === undefined ? {} : { maxResultBytes: options.maxResultBytes }),
  };
  const sessions = new Map<string, BrowserSession>();

  const sessionFor = (context: WorkspaceModuleCallContext): BrowserSession => {
    const { executionId } = context;
    const existing = sessions.get(executionId);
    if (existing) return existing;
    const session = options.browser.session(sessionOptions);
    sessions.set(executionId, session);
    context.defer(async () => {
      sessions.delete(executionId);
      for (const line of reportLines(await session.close())) context.log(line);
    });
    return session;
  };

  const call = (session: BrowserSession, name: BrowserFunctionName, input: unknown) => {
    switch (name) {
      case "send":
        return session.send(input);
      case "attachToTarget":
        return session.attachToTarget(input);
      case "spec":
        return session.spec();
      case "getDebugLog":
        return session.getDebugLog(input);
      case "clearDebugLog":
        return session.clearDebugLog();
    }
  };

  const functions: Record<string, WorkspaceModuleFunctions[string]> = {};
  for (const name of BROWSER_FUNCTION_NAMES) {
    functions[name] = async (args, context) => {
      if (args.length > 1) {
        throw new Error(`ws:browser ${name} takes one options object.`);
      }
      return call(sessionFor(context), name, args[0] ?? undefined);
    };
  }
  const create = (): WorkspaceModuleFunctions => functions;
  return Object.assign(create, { description: DESCRIPTION });
}
