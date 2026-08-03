// Workspace observer hook — a span-shaped instrumentation seam.
//
// The package emits one span per documented operation:
//
//   workspace.connect            — one per `connect()` attempt against a
//                                  single backend. Wraps the backend's
//                                  connect() + watermark reconcile.
//   workspace.sync.push          — one per `Workspace.push()` call.
//   workspace.sync.pull          — one per `Workspace.pull()` call.
//   workspace.runtime.exec         — one per command executor exec() call,
//                                  covering pre-exec push, the spawn
//                                  request, and (when `result()` is
//                                  awaited) the post-drain pull.
//   workspace.fs.<op>            — one per filesystem call routed through
//                                  the `WorkspaceStub` boundary
//                                  (readFile, writeFile, stat, readdir,
//                                  find, ls, grep, mkdir, rm).
//
// Spans nest the way callers would expect. An `exec()` whose `result()`
// is awaited produces a `workspace.runtime.exec` parent with
// `workspace.sync.push` and `workspace.sync.pull` children. The nesting
// is whatever the active context provides — for the built-in Cloudflare
// `ctx.tracing` adapter that is the AsyncContextFrame; for an
// `@opentelemetry/api` adapter it is the OTel active context. A no-op
// observer (the default) trivially supports both.
//
// Why this shape and not a passive event stream
// ---------------------------------------------
// The Cloudflare runtime exposes user-defined spans through
// `ctx.tracing.enterSpan(name, callback)` only. The callback owns both
// ends of the span; there is no way to start a span and end it from a
// different stack. To stay compatible with that surface, the workspace
// hands the adapter a callback to wrap rather than emitting separate
// `start` / `end` events.
//
// The OpenTelemetry adapter is a strict superset: it can express
// everything the Cloudflare adapter can.
//
// Attributes
// ----------
// Attribute values are restricted to `boolean | number | string`,
// matching the Cloudflare runtime's `Span.setAttribute` signature.
// Adapters that target a richer system can widen on their own side.
//
// Span names are kept under 64 bytes so the Cloudflare runtime accepts
// them without truncation.
//
// Errors
// ------
// If the wrapped work throws (or its returned promise rejects), the
// span records `error.message` and `error.name` as attributes, then
// re-throws. Error messages are bounded and common credential forms
// are redacted before they reach an observer. The runtime decides what
// "failed span" means on its own
// side — we do not call any explicit `setStatus`-shaped API because the
// Cloudflare surface does not expose one.

/**
 * Attribute values accepted by `WorkspaceSpan.setAttribute` and the
 * initial `attributes` map passed to `Observer.span`.
 *
 * Restricted to scalar types so the same shape works against the
 * Cloudflare runtime's built-in `Span.setAttribute` and against
 * `@opentelemetry/api` without per-adapter coercion.
 */
export type WorkspaceAttributeValue = boolean | number | string;

/**
 * Initial attributes passed when a span is started. `undefined` values
 * are dropped — adapters do not forward them to the underlying span.
 * This matches the Cloudflare runtime, where `setAttribute(key,
 * undefined)` is a no-op.
 */
export type WorkspaceAttributes = Readonly<Record<string, WorkspaceAttributeValue | undefined>>;

/**
 * Handle passed to the callback inside `Observer.span`. The only
 * mutating method is `setAttribute`, matching the Cloudflare
 * `ctx.tracing` `Span` surface. Adapters that target a richer system
 * may expose more on their own internal types, but the workspace
 * itself only ever calls these methods.
 */
export interface WorkspaceSpan {
  /**
   * Sets a single attribute on the span. Passing `undefined` is a
   * no-op so callers can forward optional values directly.
   */
  setAttribute(key: string, value: WorkspaceAttributeValue | undefined): void;
}

/**
 * Observer hook. A single `span` method that wraps a piece of work —
 * the adapter starts a span, runs the callback, and ends the span when
 * the callback's return value (or its returned promise) settles.
 *
 * The default observer is a no-op (see `noopObserver`); the workspace
 * uses it when the caller does not pass one. Adapters live in separate
 * subpaths so callers do not pay for `@opentelemetry/api` or
 * `cloudflare:workers` just to import the workspace.
 */
export interface WorkspaceObserver {
  /**
   * Wraps `run` in a span named `name`, seeded with `attributes`. The
   * callback receives a `WorkspaceSpan` it can use to attach further
   * attributes once the work has produced values worth recording (byte
   * counts, exit codes, applied / skipped counts).
   *
   * Implementations must run `run` synchronously and return its result
   * (or its promise) unchanged so the wrapping is invisible to the
   * caller. Errors thrown by `run` must propagate.
   */
  span<T>(
    name: string,
    attributes: WorkspaceAttributes,
    run: (span: WorkspaceSpan) => Promise<T>,
  ): Promise<T>;
}

const NOOP_SPAN: WorkspaceSpan = {
  setAttribute() {
    // intentionally empty
  },
};

/**
 * Observer that does no work. Used when the caller does not pass one.
 * Calling `span(...)` returns the callback's promise directly, with no
 * extra `await` and no allocation beyond what the callback itself does.
 */
export const noopObserver: WorkspaceObserver = {
  span(_name, _attributes, run) {
    return run(NOOP_SPAN);
  },
};

/**
 * Internal helper: wraps `run` with `observer.span(...)`, applies any
 * `undefined`-filtered attributes the work produces on settlement, and
 * records error details on rejection before re-throwing.
 *
 * The `finalize` callback runs with the result (on success) or the
 * thrown error (on failure) and is the single place call sites attach
 * post-hoc attributes like byte counts, exit codes, or applied counts.
 * Both branches are wrapped in try/catch so a buggy `finalize` does
 * not mask the original outcome.
 */
export function withSpan<T>(
  observer: WorkspaceObserver,
  name: string,
  attributes: WorkspaceAttributes,
  run: () => Promise<T>,
  finalize?: (span: WorkspaceSpan, outcome: SpanOutcome<T>) => void,
): Promise<T> {
  return observer.span(name, attributes, async (span) => {
    try {
      const value = await run();
      if (finalize) {
        try {
          finalize(span, { ok: true, value });
        } catch {
          // finalize errors are not actionable here — the work
          // succeeded, surface that to the caller.
        }
      }
      return value;
    } catch (error) {
      recordError(span, error);
      if (finalize) {
        try {
          finalize(span, { ok: false, error });
        } catch {
          // see above
        }
      }
      throw error;
    }
  });
}

/**
 * Outcome handed to the `finalize` callback of `withSpan`. Discriminated
 * by `ok` so call sites can read `value` or `error` without casts.
 */
export type SpanOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Records `error.message` and `error.name` on `span`. Messages are
 * bounded and common credential forms are redacted. Adapters that
 * want richer error reporting can subscribe to the underlying span
 * system directly; the workspace itself only forwards what the
 * Cloudflare `Span` surface accepts.
 */
function recordError(span: WorkspaceSpan, error: unknown): void {
  if (error instanceof Error) {
    span.setAttribute("error.name", error.name);
  }
  span.setAttribute("error.message", safeErrorMessage(error));
}

const MAX_SAFE_ERROR_LENGTH = 512;

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message, (character) =>
    character < " " || character.charCodeAt(0) === 127 ? " " : character,
  )
    .join("")
    .replace(
      /\b(authorization|token|api[_-]?key|password|secret|cookie)=([^\s&]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .slice(0, MAX_SAFE_ERROR_LENGTH);
}
