// Cloudflare runtime adapter for the workspace observer hook.
//
// Wires `@cloudflare/computer`'s span-shaped observer to the Cloudflare
// runtime's built-in user tracing surface (`Tracing.enterSpan`). The
// runtime owns the span lifecycle: it opens the span, propagates the
// active context through `AsyncContextFrame` so nested spans become
// children automatically, and ends the span when the callback's return
// value (or promise) settles.
//
// Two ways to obtain a `Tracing` handle in user code:
//
//   import { tracing } from "cloudflare:workers";
//
//   const observer = createCloudflareObserver({ tracing });
//
// or, when an `ExecutionContext` is on hand:
//
//   const observer = createCloudflareObserver({ tracing: ctx.tracing });
//
// `ctx.tracing` is optional on the `ExecutionContext` type because the
// runtime omits it in environments without the user-tracing feature
// flag. The adapter accepts `Tracing | undefined`; when it is undefined
// the observer is a pure pass-through.
//
// Why this adapter is so small
// ----------------------------
// The shape of `WorkspaceObserver.span(name, attributes, run)` is a
// faithful subset of `tracing.enterSpan(name, callback)`. The only
// real work the adapter does is forward seed attributes onto the
// runtime span and hand a `setAttribute`-shaped facade to the workspace
// callback. Errors propagate through `enterSpan` naturally; the
// workspace's own `withSpan` helper records `error.name` /
// `error.message` before re-throwing.
//
// Why we do not depend on `cloudflare:workers`
// --------------------------------------------
// The adapter takes the `Tracing` instance as an argument rather than
// importing it directly. That keeps this file resolvable under the
// node-based unit tests (where `cloudflare:workers` is not present),
// and it keeps the computer package free of an implicit dependency on
// the runtime module specifier in tools that do not understand it.

import type { WorkspaceObserver, WorkspaceSpan } from "../observe.js";

export interface CloudflareObserverOptions {
  /**
   * The runtime's user-tracing handle. Pass `ctx.tracing` from inside a
   * Worker or Durable Object, or `tracing` imported from
   * `cloudflare:workers`. `undefined` is accepted because the runtime
   * omits the property in environments without the user-tracing
   * feature flag; the adapter then degrades to a pass-through.
   */
  tracing: Tracing | undefined;
}

/**
 * Build a `WorkspaceObserver` backed by the Cloudflare runtime's built-in
 * user tracing surface.
 *
 * When `tracing` is `undefined`, returns an observer that runs the
 * callback directly with a span object whose `setAttribute` is a no-op.
 * This lets the same wiring code work in environments without the
 * user-tracing feature flag, without forcing callers to branch on a
 * possibly-undefined `ctx.tracing`.
 */
export function createCloudflareObserver(options: CloudflareObserverOptions): WorkspaceObserver {
  const { tracing } = options;
  if (!tracing) return passThroughObserver;
  return {
    span(name, attributes, run) {
      // The runtime requires the operation name to fit in 64 bytes.
      // Names emitted by the workspace are well under that today
      // (longest is `workspace.shell.exec.spawn` at 26 bytes), so no
      // truncation is needed here; an over-length name is a workspace
      // bug rather than a caller bug.
      return tracing.enterSpan(name, (runtimeSpan) => {
        applyAttributes(runtimeSpan, attributes);
        // Wrap the runtime span in a `WorkspaceSpan` facade. The facade
        // forwards `setAttribute` directly; `undefined` values are
        // dropped so callers can pass optional fields without
        // conditionals.
        const span: WorkspaceSpan = {
          setAttribute(key, value) {
            if (value === undefined) return;
            runtimeSpan.setAttribute(key, value);
          },
        };
        return run(span);
      });
    },
  };
}

function applyAttributes(
  runtimeSpan: Span,
  attributes: Readonly<Record<string, boolean | number | string | undefined>>,
): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    runtimeSpan.setAttribute(key, value);
  }
}

// Used when the runtime does not expose `Tracing`. The callback runs
// inline and the span facade is a no-op, matching the package's default
// `noopObserver`. Duplicated here rather than re-exported to keep the
// adapter file self-contained and avoid pulling the package entry into
// the import graph of every adapter consumer.
const passThroughSpan: WorkspaceSpan = {
  setAttribute() {
    // intentionally empty
  },
};

const passThroughObserver: WorkspaceObserver = {
  span(_name, _attributes, run) {
    return run(passThroughSpan);
  },
};
