// Stub leak tracking. Gated on the CAPNWEB_TRACK_STUBS env flag so
// production paths pay nothing. Every RpcTarget we own opts in by
// calling `trackStub(this)` in its constructor; capnweb may invoke
// `[Symbol.dispose]` more than once for a shared target as sessions
// end, so repeated disposals for the same object are ignored.
//
// The point is *measurement*, not enforcement: snapshot() returns the
// per-class live count so a soak script can assert "after a quiet
// point, every counter is zero." Anything non-zero is a leak —
// either we forgot to dispose a result envelope on the caller side,
// or the disposal contract broke.

// Read the flag at module init. Both Node (process.env) and
// workerd (globalThis override) are tolerated; runtimes without
// either surface (notably workerd, where env vars only land on
// the binding object) can call enableStubTracking() programmatically.
let trackingEnabled: boolean = readFlag();

function readFlag(): boolean {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    if (env?.CAPNWEB_TRACK_STUBS === "1") return true;
  } catch {
    // ignore — process isn't available in this runtime
  }
  const override = (globalThis as { CAPNWEB_TRACK_STUBS?: unknown }).CAPNWEB_TRACK_STUBS;
  return override === "1" || override === true;
}

// Force tracking on. Useful for workerd-based tests where the env
// var doesn't reach process.env or globalThis. Idempotent.
export function enableStubTracking(): void {
  trackingEnabled = true;
}

const counters = new Map<string, number>();
const trackedTargets = new WeakSet<object>();

export function trackStub(target: object): void {
  if (!trackingEnabled) return;
  if (trackedTargets.has(target)) return;
  trackedTargets.add(target);
  const name = target.constructor?.name ?? "anonymous";
  counters.set(name, (counters.get(name) ?? 0) + 1);
}

export function untrackStub(target: object): void {
  if (!trackingEnabled) return;
  if (!trackedTargets.delete(target)) return;
  const name = target.constructor?.name ?? "anonymous";
  const current = counters.get(name) ?? 0;
  if (current <= 1) counters.delete(name);
  else counters.set(name, current - 1);
}

// Snapshot the current live counts. Empty object when tracking is
// disabled or when nothing is live. Callers should not mutate the
// returned object — it's a fresh copy on every call.
export function stubSnapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, count] of counters) out[name] = count;
  return out;
}

// True iff tracking is on (env flag, globalThis override, or
// enableStubTracking() was called). Useful for skipping diagnostic
// surfaces when tracking is off.
export function isStubTrackingEnabled(): boolean {
  return trackingEnabled;
}
