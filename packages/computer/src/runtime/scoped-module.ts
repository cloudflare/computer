import type {
  WorkspaceModuleExecution,
  WorkspaceModuleFunctions,
  WorkspaceModuleHost,
} from "./types";

declare const scopedModuleBrand: unique symbol;

// Marks what `createScopedModule()` returns. A symbol, so it can't
// collide with an export name, and a registered one, so two copies of
// this package agree on it.
const SCOPED_MODULE = Symbol.for("@cloudflare/computer/scoped-module");

/** How a scope ended, as `WorkspaceScopedModuleInstance.close` is told. */
export type WorkspaceModuleScopeEnd =
  | {
      /**
       * The run is waiting in `ctx.interrupt()` and has released its
       * isolate. Its code starts again from the top when it resumes, in
       * a new scope with a new instance.
       */
      readonly reason: "paused";
      /** Aborts at `deadline`, when the backend stops waiting for `close`. */
      readonly signal: AbortSignal;
      /** Epoch milliseconds after which the backend stops waiting for `close`. */
      readonly deadline: number;
    }
  | {
      /** How the run ended. */
      readonly reason: "completed" | "failed" | "cancelled";
      readonly signal: AbortSignal;
      readonly deadline: number;
      /**
       * Append text to the run's stderr, before its exit. Text past what
       * is left of the run's output limit is cut, and ends with a line
       * saying so. Anything logged after `close` returns is dropped.
       */
      log(text: string): void;
    };

/**
 * One scope of a run: from when its code starts in an isolate until it
 * waits in `ctx.interrupt()` or ends. A run that resumes starts a new
 * scope with the same `id`.
 */
export interface WorkspaceModuleScope extends WorkspaceModuleExecution {
  /** Aborts when the scope is cancelled or its isolate is released. */
  readonly signal: AbortSignal;
}

/** A scoped module's instance for one scope, from its `start`. */
export interface WorkspaceScopedModuleInstance {
  /** The functions code imports. Their names must match the module's `exports`. */
  readonly functions: WorkspaceModuleFunctions;
  /**
   * Let go of what the instance holds. Called once, after the scope's
   * host calls settle: when the run pauses in `ctx.interrupt()`, before
   * it can resume, or when it ends, before its exit is published. A
   * close that throws or misses its deadline is reported with
   * `console.error`, and the run goes on as it would have.
   */
  close?(end: WorkspaceModuleScopeEnd): void | Promise<void>;
}

/** What `createScopedModule()` takes. */
export interface WorkspaceScopedModuleOptions {
  /** What the module does and how to call it, for a model. */
  readonly description?: string;
  /**
   * The names code can import. The backend needs them before any run
   * starts, and checks that every instance's functions match them.
   */
  readonly exports: readonly string[];
  /**
   * Make the instance for one scope, on that scope's first call to the
   * module. A call answered from the run's journal doesn't count. Calls
   * made while it starts wait for it, and if it throws, they fail.
   * `scope.signal` aborts when the scope is cancelled or released, and a
   * call whose own signal has aborted by then fails.
   */
  start(
    scope: WorkspaceModuleScope,
    host: WorkspaceModuleHost,
  ): WorkspaceScopedModuleInstance | Promise<WorkspaceScopedModuleInstance>;
}

/** A host module with one instance per scope; see `createScopedModule()`. */
export interface WorkspaceScopedModule extends WorkspaceScopedModuleOptions {
  readonly [scopedModuleBrand]: true;
}

/**
 * A host module with an instance for each scope of a run, for state
 * such as a browser session. A scope lasts from when the run's code
 * starts in an isolate until it waits in `ctx.interrupt()` or ends. The
 * backend calls `start` on the scope's first call to the module, shares
 * the instance with the scope's other calls, and closes it when the
 * scope ends. A run that resumes starts again from the top in a new
 * scope, with a new instance, so nothing held in memory outlives a
 * scope. An instance closes only if it started. Experimental: it may
 * change in any release.
 *
 * ```ts
 * "codemode:browser": createScopedModule({
 *   exports: ["open"],
 *   async start(scope, host) {
 *     const session = await connect(scope.metadata.conversation);
 *     return {
 *       functions: { open: ([url]) => session.open(String(url)) },
 *       async close(end) {
 *         await session.close();
 *         if (end.reason !== "paused") end.log("Closed the browser.\n");
 *       },
 *     };
 *   },
 * }),
 * ```
 */
export function createScopedModule(options: WorkspaceScopedModuleOptions): WorkspaceScopedModule {
  // SAFETY: The symbol written here is the brand the type names.
  return Object.freeze({
    ...options,
    exports: Object.freeze([...options.exports]),
    [SCOPED_MODULE]: true,
  }) as unknown as WorkspaceScopedModule;
}

export function isScopedModule(module: unknown): module is WorkspaceScopedModule {
  return (
    typeof module === "object" &&
    module !== null &&
    (module as { [SCOPED_MODULE]?: unknown })[SCOPED_MODULE] === true
  );
}
