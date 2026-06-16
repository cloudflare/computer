// Container lifecycle helpers.
//
// `WorkspaceContainerAPI` is constructed fresh on every
// getWorkspaceContainer() call, so instance fields can't track
// monitor state across calls. The state lives in a module-level
// WeakMap keyed by the owning DO's ctx; each DO gets one slot,
// garbage-collected when the DO is reclaimed.
//
// The lifecycle helpers here are independent of any
// cloudflare:workers imports so they can be unit-tested under the
// node-based vitest runner.

type ContainerHandle = NonNullable<DurableObjectState["container"]>;

export interface ContainerExitInfo {
  exitedAt: number;
  reason: string;
}

interface ContainerLifecycleState {
  // Populated when the in-flight monitor() resolves or rejects.
  exit: ContainerExitInfo | null;
  // The monitor() promise we attached to the current container
  // generation. null between generations and before the first
  // start().
  monitorArmed: Container | null;
  // Set just before our own destroy() so the monitor handler
  // records the exit as intentional and logs at info, not warn.
  expectingExit: boolean;
}

// Wrapper type so the test stand-in can be plain object literals
// without needing the full Container interface to type-check.
type Container = ContainerHandle;

const LIFECYCLE = new WeakMap<DurableObjectState, ContainerLifecycleState>();

export function getContainerLifecycle(ctx: DurableObjectState): ContainerLifecycleState {
  let state = LIFECYCLE.get(ctx);
  if (state === undefined) {
    state = { exit: null, monitorArmed: null, expectingExit: false };
    LIFECYCLE.set(ctx, state);
  }
  return state;
}

export function containerExitInfo(ctx: DurableObjectState): ContainerExitInfo | null {
  return getContainerLifecycle(ctx).exit;
}

export function formatExitReason(error: unknown): string {
  if (error === undefined) return "exited normally";
  if (error instanceof Error) return error.message;
  return String(error);
}

// Arm a monitor() for the currently-attached container generation.
// Idempotent: a second call for the same generation is a no-op so
// callers can invoke this on every start() without double-attaching.
//
// The monitor handler records exit info, logs once, and clears the
// armed reference so the next start() can re-arm. Both branches
// (resolve, reject) feed into the same recorder.
export function armContainerMonitor(ctx: DurableObjectState, container: Container): void {
  const state = getContainerLifecycle(ctx);
  if (state.monitorArmed === container) return;
  state.monitorArmed = container;
  // Clear any prior exit info — a fresh generation has started.
  state.exit = null;

  const promise = container.monitor();
  promise.then(
    () => recordExit(state, undefined),
    (error) => recordExit(state, error),
  );
}

// Tear down the current container generation. Sets expectingExit
// so the monitor handler logs the resulting exit as intentional.
// Clears the flag in a finally so a failing destroy() does not
// leave a stale flag that would mis-classify a later real crash.
export async function destroyContainerExpectingExit(
  ctx: DurableObjectState,
  container: Container,
): Promise<void> {
  const state = getContainerLifecycle(ctx);
  state.expectingExit = true;
  try {
    await container.destroy();
  } finally {
    // The monitor handler observes expectingExit synchronously the
    // moment destroy() resolves the monitor promise. Clearing here
    // races the handler — but the handler has already snapshotted
    // the flag by the time it runs (recordExit reads expectingExit
    // first), so clearing now is safe.
    state.expectingExit = false;
    state.monitorArmed = null;
  }
}

// Reset state for a ctx. Test-only escape hatch; the production
// path relies on WeakMap GC.
export function resetContainerLifecycleForTests(ctx: DurableObjectState): void {
  LIFECYCLE.delete(ctx);
}

function recordExit(state: ContainerLifecycleState, error: unknown): void {
  const expected = state.expectingExit;
  const reason = formatExitReason(error);
  const exitedAt = Date.now();
  state.exit = { reason, exitedAt };
  // Log a single line per exit. Single-object form so Cloudflare
  // Logs picks up the structured fields alongside the message.
  if (expected) {
    console.info({
      message: "workspace.container.exited",
      reason,
      exitedAt,
      expected: true,
    });
  } else {
    console.warn({
      message: "workspace.container.exited",
      reason,
      exitedAt,
      expected: false,
    });
  }
}
