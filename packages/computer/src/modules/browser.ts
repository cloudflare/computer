// `codemode:browser`: an agent's persistent browser for isolate JavaScript.
//
//   import * as browser from "codemode:browser";
//   await browser.cdp({ method: "Page.navigate", params: { url }, sessionId: "active" });
//
// The browser is an agents `Browser`, and the exports are its `browser.*`
// functions, the same ones `browserTool` gives its code. Each run that
// calls the module opens one session on its first call and closes it
// when the run pauses or ends, which saves the run's active tab for the
// next run in its browser scope.
//
// Computer takes no dependency on agents, so the parts of the contract
// this module uses are typed here by shape.
//
// "Scope" means two things here. The browser scope is which tab a
// session drives ("shared", "conversation:<id>"), as agents names it.
// A module scope is Computer's: one stretch of a run between starting
// in an isolate and pausing or ending, which `start` is called for.

import {
  type CodemodeModule,
  createCodemodeModule,
  type WorkspaceModuleScope,
} from "../runtime/codemode-module";
import { unsafeToRepeat } from "../runtime/replay-safety";
import type {
  WorkspaceModuleExecution,
  WorkspaceModuleFunction,
  WorkspaceModuleHost,
} from "../runtime/types";

/** The agents `Browser`, as this module uses it. */
export interface BrowserModuleSource {
  /** The `browser.*` functions in Markdown, and the rules for using them. */
  functionDocs(): { readonly functions: string; readonly rules: readonly string[] };
  /** Open a session that connects on its first call. */
  session(options: { scope: string; lock?: boolean }): BrowserModuleSession;
}

/** An agents `BrowserSession`, as this module uses it. */
export interface BrowserModuleSession {
  /** The `browser.*` functions bound to the session, by name. */
  readonly functions: Readonly<Record<string, (input: unknown) => Promise<unknown>>>;
  /** Take the browser scope's lock; rejects with the signal's reason when it aborts. */
  lock(options: { signal?: AbortSignal }): Promise<void>;
  /** How long the session waited for its lock, in milliseconds. */
  readonly waitedForLockMs: number;
  /** Save the active tab, release the lock, and report what happened to the browser. */
  close(): Promise<{ readonly notices: readonly string[] } | undefined>;
}

/** Options for {@link createBrowserModule}. */
export interface BrowserModuleOptions {
  /** The agent's `Browser`, from `agents/browser`. */
  readonly browser: BrowserModuleSource;
  /**
   * The browser scope a run drives: runs in one browser scope share an
   * active tab and take turns. A string, or a function that picks one
   * from the run's `id` and `metadata`. Defaults to `"shared"`. A
   * function may throw when a run without the metadata it needs
   * shouldn't browse.
   */
  readonly scope?: string | ((execution: WorkspaceModuleExecution) => string);
  /**
   * How long a run waits for its turn with the browser before it gives
   * up, in milliseconds. Defaults to 45000 (45 seconds). Keep it under
   * the run's timeout and the backend's `maxHostCallMs`, so the run
   * gets this module's error rather than timing out.
   */
  readonly lockTimeoutMs?: number;
  /**
   * The specifier the backend serves this module under, which its
   * description tells code to import and its errors name. Defaults to
   * `"codemode:browser"`. Set it when the module is served under another
   * name, or under a backend's `scheme`, such as `"agent:browser"`.
   */
  readonly specifier?: string;
  /**
   * The specifier of the module that serves the agent's tools, which the
   * description tells code not to call the browser tool through. Defaults
   * to `"codemode:tools"`.
   */
  readonly toolsSpecifier?: string;
}

const DEFAULT_BROWSER_SCOPE = "shared";
const DEFAULT_LOCK_TIMEOUT_MS = 45_000;
// A run that waited less than this for its turn isn't told about it.
const NOTICEABLE_WAIT_MS = 1_000;

const DEFAULT_SPECIFIER = "codemode:browser";
const DEFAULT_TOOLS_SPECIFIER = "codemode:tools";

const workspaceRules = (specifier: string, toolsSpecifier: string) => [
  `Import the module as a namespace, \`import * as browser from ${JSON.stringify(specifier)}\`, and call \`browser.<name>({ ... })\` as above.`,
  "Notices about the browser (it restarted, your tab was closed, the page opened tabs) are written to stderr after the run ends.",
  'To look at a page, save a screenshot and open the file with `read`: `const { data } = await browser.cdp({ method: "Page.captureScreenshot", sessionId: "active" })`, then `await fs.writeFile(path, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))` with `node:fs/promises`.',
  "One call returns at most 1 MiB, and a run's calls share 8 MiB each way, so take about eight screenshots per run at most, and print PDFs in a run of their own.",
  "Runs that use the browser take turns, even when started together: a run waits until the runs ahead of it end. To work on several pages, do it in one run: open a tab per page with Target.createTarget and drive them with Promise.all.",
  `Don't call the browser tool from code through \`${toolsSpecifier}\`: it waits for this run's turn, which only ends when this run does.`,
];

/**
 * Build the `codemode:browser` host module over an agents `Browser`.
 *
 * It exports the browser's `browser.*` functions. Each run that calls
 * one opens a session in its browser scope, waits for its turn with
 * the browser, and closes the session when it pauses or ends; when it
 * ends, the session's notices go to its stderr. A run fails at once if
 * a run waiting for an answer holds its browser scope. Every function
 * needs Workspace write access, since browsing can change things on the
 * sites the browser is logged in to.
 *
 * @param options - The browser, the browser scope, how long to wait for a
 *   turn, and the specifiers its description names.
 * @returns The module to pass as `modules["codemode:browser"]`.
 * @throws When `scope` is an empty string.
 */
export function createBrowserModule(options: BrowserModuleOptions): CodemodeModule {
  const { browser } = options;
  const scope = options.scope ?? DEFAULT_BROWSER_SCOPE;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const specifier = options.specifier ?? DEFAULT_SPECIFIER;
  const toolsSpecifier = options.toolsSpecifier ?? DEFAULT_TOOLS_SPECIFIER;
  if (scope === "") throw new Error(`${specifier}: scope must not be empty.`);
  const browserScopeOf = ({ id, metadata }: WorkspaceModuleExecution): string => {
    const value = typeof scope === "function" ? scope({ id, metadata }) : scope;
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `${specifier}: the scope function returned ${JSON.stringify(value)} for run ${id}; a browser scope must be a non-empty string.`,
      );
    }
    return value;
  };

  // The function table depends only on the browser, not the session. A
  // session connects on its first call and, without `lock`, holds
  // nothing until then, so reading its table needs no close.
  const exportNames = Object.keys(browser.session({ scope: DEFAULT_BROWSER_SCOPE }).functions);

  const docs = browser.functionDocs();
  // The backend lists each module as one bullet, so every line after
  // the first is indented under it.
  const description = [
    "A persistent Chrome browser, driven over the Chrome DevTools Protocol (CDP). It keeps its tabs, cookies and logins between runs.",
    "",
    docs.functions,
    "",
    "Rules:",
    ...[...docs.rules, ...workspaceRules(specifier, toolsSpecifier)].map((rule) => `- ${rule}`),
  ]
    .join("\n")
    .split("\n")
    .map((line, index) => (index === 0 || line === "" ? line : `  ${line}`))
    .join("\n");

  const module = createCodemodeModule({ description });

  // Runs that paused with a session open, by run id: the browser scope
  // and when the session closed. This lives in memory, so after the
  // Durable Object restarts a waiting run holds nothing until it resumes
  // and browses again.
  const pausedWithSession = new Map<string, PausedClaim>();
  const sessionRuns = new WeakMap<BrowserModuleSession, { id: string; browserScope: string }>();

  // One session per module scope, opened by the first live call that
  // reads ctx.session. Calls racing it share the start; a start that
  // throws stays failed for the scope.
  module.context(
    "session",
    async (run: WorkspaceModuleScope, host: WorkspaceModuleHost) => {
      const browserScope = browserScopeOf(run);
      await assertNotHeldByPausedRun(specifier, host, run, browserScope, pausedWithSession);

      const session = browser.session({ scope: browserScope, lock: true });
      const timeout = AbortSignal.timeout(lockTimeoutMs);
      try {
        await session.lock({ signal: AbortSignal.any([run.signal, timeout]) });
      } catch (error) {
        await session.close();
        if (timeout.aborted && !run.signal.aborted) {
          throw new Error(
            `${specifier}: gave up waiting for the browser after ${Math.round(lockTimeoutMs / 1000)}s: other runs in browser scope ${JSON.stringify(browserScope)} were using it. Runs that use the browser take turns, so try again once they finish.`,
          );
        }
        throw error;
      }
      // The run that had the lock may have paused for a person while
      // this one waited. A run marks itself waiting before it releases
      // the lock, so checking again now can't miss it.
      try {
        await assertNotHeldByPausedRun(specifier, host, run, browserScope, pausedWithSession);
      } catch (error) {
        await session.close();
        throw error;
      }
      sessionRuns.set(session, { id: run.id, browserScope });
      return session;
    },
    {
      scoped: true,
      async dispose(session, end) {
        const owner = sessionRuns.get(session);
        if (owner !== undefined) {
          // Claimed before close releases the lock, so a run that gets
          // the lock from this close sees the claim when it checks.
          if (end.reason === "paused") {
            pausedWithSession.set(owner.id, {
              browserScope: owner.browserScope,
              closedAt: Date.now(),
            });
          } else {
            pausedWithSession.delete(owner.id);
          }
        }
        const report = await session.close();
        if (end.reason === "paused") return;
        for (const notice of report?.notices ?? []) end.log(`${notice}\n`);
        const waited = session.waitedForLockMs;
        if (waited >= NOTICEABLE_WAIT_MS) {
          end.log(
            `This run waited ${Math.round(waited / 1000)}s for its turn with the browser, while other runs in its browser scope used it.\n`,
          );
        }
      },
    },
  );

  const functions: Record<string, WorkspaceModuleFunction> = {};
  for (const name of exportNames) {
    functions[name] = async (args, ctx) => {
      if (ctx.access !== "read-write") {
        throw new Error(`${specifier} ${name} requires Workspace write access.`);
      }
      if (args.length > 1) {
        throw new TypeError(`browser.${name}(input) takes one input object.`);
      }
      const session = await (ctx as typeof ctx & { session: Promise<BrowserModuleSession> })
        .session;
      const fn = session.functions[name];
      if (fn === undefined) throw new Error(`browser.${name} is not available.`);
      return fn(args[0]);
    };
  }
  // A repeated CDP command can submit a form or buy something twice.
  if (functions.cdp) unsafeToRepeat(functions.cdp);

  return module.module(functions);
}

interface PausedClaim {
  readonly browserScope: string;
  /** When the run's session closed for the pause, in epoch milliseconds. */
  readonly closedAt: number;
}

// A run waiting for an answer has closed its session, so it no longer
// holds the lock, but its browser scope's tab is where it left off.
// Another run there would move it, so it fails rather than waits: the
// answer may take hours.
//
// A waiting run holds its browser scope only if its session closed for
// this wait: a run marks itself waiting before its session closes, so
// a wait that started later, from a scope that didn't browse or a run
// that reused the id, holds nothing. Claims for runs no longer waiting
// are dropped here, since only a waiting run can hold a scope.
async function assertNotHeldByPausedRun(
  specifier: string,
  host: WorkspaceModuleHost,
  run: WorkspaceModuleScope,
  browserScope: string,
  pausedWithSession: Map<string, PausedClaim>,
) {
  const pending = await host.runtime.pending();
  const waiting = new Set(pending.map((call) => call.id));
  for (const id of pausedWithSession.keys()) {
    if (!waiting.has(id)) pausedWithSession.delete(id);
  }
  for (const call of pending) {
    if (call.id === run.id) continue;
    const claim = pausedWithSession.get(call.id);
    if (claim?.browserScope === browserScope && call.since <= claim.closedAt) {
      throw new Error(
        `${specifier}: browser scope ${JSON.stringify(browserScope)} is held by a run that's waiting for a person (run ${call.id}). Try again once it has its answer.`,
      );
    }
  }
}
