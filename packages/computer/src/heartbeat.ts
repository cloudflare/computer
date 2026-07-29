// Periodic heartbeat for a SyncRPC transport.
//
// Two responsibilities, served by the same timer:
//
//   - Detect a dead peer. A WebSocket can be silently broken
//     (unclean RST, host OOM with no FIN frame) without the close
//     event firing for tens of seconds. Calling a cheap RPC on a
//     timer surfaces the failure in O(interval) instead.
//   - Keep middleboxes warm. CF edge, NAT, customer middleboxes have
//     idle disconnect timers in the 100–600s range. Application
//     traffic resets them.
//
// `ping` is whatever the caller wants to use as a liveness probe.
// SyncRPC.watermarks() is the natural choice — three SQL scalars,
// no side effects, exercises the wire end-to-end. `onFailure` fires
// exactly once if ping rejects; the heartbeat then stops on its own
// so a dead transport doesn't accumulate failures.

export interface HeartbeatOptions {
  intervalMs: number;
  ping: () => Promise<unknown>;
  onFailure: (error: Error) => void;
}

export function startHeartbeat(options: HeartbeatOptions): () => void {
  const { intervalMs, ping, onFailure } = options;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    ping().catch((error) => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      onFailure(error instanceof Error ? error : new Error(String(error)));
    });
  }, intervalMs);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
