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
  // Only the monitor whose generation matches `currentGeneration`
  // is allowed to write here — a stale handler from a previous
  // generation must not poison the fresh one's exit state.
  exit: ContainerExitInfo | null;
  // Monotonically incremented every time a new monitor is armed.
  // The installContainerMonitor closure captures the value at arm
  // time so a late-resolving old monitor can detect that it has
  // been superseded.
  currentGeneration: number;
  // The generation whose monitor is expected to terminate — set
  // by destroyContainerExpectingExit just before the destroy call.
  // The monitor handler reads this and, if it matches its own
  // generation, logs the exit as intentional. Storing the
  // generation (not a boolean) means a later spurious clear can
  // never affect the current generation, and a flag set against
  // generation N cannot leak into generation N+1.
  expectedExitGeneration: number | null;
  // Resolves once the *current* generation's monitor handler has
  // run to completion. destroyContainerExpectingExit awaits this
  // so the expected-exit log is emitted before any subsequent
  // installContainerMonitor bumps the generation out from under
  // the in-flight handler. Null between generations and before
  // the first install.
  currentMonitorSettled: Promise<void> | null;
}

const LIFECYCLE = new WeakMap<DurableObjectState, ContainerLifecycleState>();

export function getContainerLifecycle(ctx: DurableObjectState): ContainerLifecycleState {
  let state = LIFECYCLE.get(ctx);
  if (state === undefined) {
    state = {
      exit: null,
      currentGeneration: 0,
      expectedExitGeneration: null,
      currentMonitorSettled: null,
    };
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
// Every call bumps the generation counter and attaches a fresh
// .then handler. The handler captures its generation at arm time
// so a stale monitor that resolves late cannot overwrite a newer
// generation's exit state.
//
// The expected-or-not classification is taken from the live
// `expectedExitGeneration` slot when the handler runs, which is
// what destroyContainerExpectingExit writes — reading the slot
// (not a closure snapshot) lets a destroy() called *after* arm
// still mark its own generation's exit as intentional.
//
// Callers (start, restart) sequence arming after a successful
// container.start(); the platform contract is "one monitor per
// generation". If a caller arms twice for the same generation,
// the worst that happens is two handlers race to write the same
// exit state — same value, same generation.
export function installContainerMonitor(
  ctx: DurableObjectState,
  container: ContainerHandle,
  onExit?: () => void | Promise<void>,
): void {
  const state = getContainerLifecycle(ctx);
  state.currentGeneration += 1;
  const generation = state.currentGeneration;
  // Clear any prior exit info — a fresh generation has started.
  state.exit = null;

  const monitorPromise = container.monitor();
  // currentMonitorSettled tracks the wrapper that runs recordExit,
  // not the raw monitor promise, so awaiting it guarantees the
  // exit has been recorded (and logged) before the awaiter
  // continues. Both branches feed into recordExit which never
  // throws, so the wrapper itself resolves rather than rejecting.
  state.currentMonitorSettled = monitorPromise.then(
    () => recordExit(state, generation, undefined, onExit),
    (error) => recordExit(state, generation, error, onExit),
  );
}

// Tear down the current container generation. Marks the current
// generation as the one expected to terminate so the monitor
// handler logs the resulting exit as intentional.
//
// The mark is keyed by generation, not by a global boolean, so a
// destroy() that fires while a different generation is in flight
// (e.g. a stale destroy attempt against a generation that has
// already been replaced) cannot mark the wrong generation's exit
// as intentional. The mark sticks until the next arm; if destroy
// throws and a fresh generation never gets armed, the mark sits
// against a generation that no longer matches `currentGeneration`
// and any later real crash on the new generation logs as a crash.
export async function destroyContainerExpectingExit(
  ctx: DurableObjectState,
  container: ContainerHandle,
): Promise<void> {
  const state = getContainerLifecycle(ctx);
  state.expectedExitGeneration = state.currentGeneration;
  // Capture the current generation's monitor wrapper BEFORE the
  // destroy. A subsequent installContainerMonitor reassigns
  // currentMonitorSettled, but the capture here pins us to the
  // one we're waiting on.
  const settled = state.currentMonitorSettled;
  await container.destroy();
  // Wait for the destroyed generation's monitor handler to run so
  // its expected-exit log fires before the caller (e.g.
  // WorkspaceContainerAPI.restart) installs the next generation's
  // monitor and bumps currentGeneration out from under it. The
  // platform settles monitor() asynchronously relative to
  // destroy(); without this await the next install supersedes the
  // pending handler and recordExit drops the write as stale.
  if (settled) await settled;
}

// Reset state for a ctx. Test-only escape hatch; the production
// path relies on WeakMap GC.
export function resetContainerLifecycleForTests(ctx: DurableObjectState): void {
  LIFECYCLE.delete(ctx);
}

async function recordExit(
  state: ContainerLifecycleState,
  generation: number,
  error: unknown,
  onExit?: () => void | Promise<void>,
): Promise<void> {
  // Drop late writes from superseded monitors. The state object is
  // shared across generations; only the current one is allowed to
  // mutate `exit`. Log nothing on a stale exit — the operator
  // already saw the live generation's exit when it happened.
  if (generation !== state.currentGeneration) return;
  const expected = state.expectedExitGeneration === generation;
  // Consume the expected mark so a later spurious monitor
  // resolution (e.g. an idempotent arm against the same
  // generation) does not double-claim the intentional log.
  if (expected) state.expectedExitGeneration = null;
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
  try {
    await onExit?.();
  } catch (cleanupError) {
    console.error({
      message: "workspace.container.exit_cleanup_failed",
      reason: formatExitReason(cleanupError),
      exitedAt: Date.now(),
    });
  }
}
