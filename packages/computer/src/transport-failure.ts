// Conservative classifier for "the backend's transport is gone".
//
// The Workspace caches a BackendHandle per backend id and clears
// it when the handle's `closed` promise resolves. A wedged
// container or a half-broken capnweb session may surface failures
// through an RPC rejection long before that promise fires. To
// avoid handing the same broken stub to the next caller, the
// Workspace runs each backend-touching RPC through a try/catch
// that consults this classifier and invalidates the cached
// handle on a match.
//
// Two ways to flag a transport failure:
//
//   1. Throw a WorkspaceTransportError from backend code we own
//      (heartbeat onFailure, lease renewal, the container backend
//      itself). Direct, no string matching.
//
//   2. Pattern-match the error message for known phrases that
//      external libraries surface (capnweb session shutdown,
//      WebSocket close, container-port unreachable). Conservative
//      by design — false positives invalidate a still-good
//      handle, which costs a reconnect; false negatives keep a
//      dead stub around until the next signal.
//
// The classifier walks the cause chain so wrappers like
// "watermark sync failed: <inner>" still classify when the inner
// error is a transport failure.

// Tag class for transport failures we throw ourselves. Carrying
// a class identity lets the classifier match without string
// inspection, and lets callers wrap an underlying cause for
// observability without losing the classification.
export class WorkspaceTransportError extends Error {
  override readonly name = "WorkspaceTransportError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

// Phrases that consistently indicate a dead transport. Conservative
// list — only phrases the workspace stack reliably produces or
// that capnweb / Cloudflare Workers ws emit on a closed session.
const PRE_DISPATCH_PATTERNS: RegExp[] = [
  // This is thrown locally when code calls a stub whose session is
  // already disposed. No frame can have been sent, so even a
  // side-effecting operation such as shell.exec is safe to retry.
  /rpc stub after it has been disposed/i,
];

const TRANSPORT_PATTERNS: RegExp[] = [
  // capnweb session shutdown / cancellation. Phrasing checked
  // against node_modules/capnweb/dist/index.js: the
  // post-shutdown error is "Attempted to use RPC stub after it
  // has been disposed." and pre-shutdown cancellation reads as
  // "RPC was canceled because RPC session was shut down...".
  /rpc session was shut down/i,
  ...PRE_DISPATCH_PATTERNS,
  /rpc was canceled/i,
  // WebSocket transport failures.
  /websocket is not open/i,
  /websocket closed/i,
  /socket hang up/i,
  // Container-port unreachable / TCP-level failures bubbling up
  // through host.fetchPort.
  /connection refused/i,
  /econnrefused/i,
  /econnreset/i,
  /network is unreachable/i,
  // The container backend's fetchPort short-circuit when it has
  // observed an exit through container.monitor(). Surfaces
  // through a WorkspaceTransportError same-isolate (handled by
  // the instanceof check below) and as a plain Error after a
  // Workers RPC hop (subclass identity is dropped by structured
  // clone). The .name check covers RPC-side; this pattern
  // covers errors that don't even carry the original name.
  /container exited/i,
];

export function isWorkspaceTransportFailure(error: unknown): boolean {
  let current: unknown = error;
  // Bounded walk so a self-referential cause chain can't loop.
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    if (current instanceof WorkspaceTransportError) return true;
    if (current instanceof Error) {
      // .name survives a Workers RPC structured-clone hop even
      // when the subclass identity does not, so cross-DO callers
      // still classify a WorkspaceTransportError correctly.
      if (current.name === "WorkspaceTransportError") return true;
      for (const pattern of TRANSPORT_PATTERNS) {
        if (pattern.test(current.message)) return true;
      }
      const next = (current as Error & { cause?: unknown }).cause;
      if (next === current) return false;
      current = next;
      continue;
    }
    return false;
  }
  return false;
}

// A transport failure does not normally reveal whether the peer
// accepted an operation before the connection died. Keep a narrower
// classifier for failures that prove dispatch never happened. Shell
// exec uses this to avoid replaying a command with unknown side
// effects; idempotent sync operations use the broader classifier.
export function isWorkspacePreDispatchTransportFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    if (!(current instanceof Error)) return false;
    for (const pattern of PRE_DISPATCH_PATTERNS) {
      if (pattern.test(current.message)) return true;
    }
    const next = (current as Error & { cause?: unknown }).cause;
    if (next === current) return false;
    current = next;
  }
  return false;
}
