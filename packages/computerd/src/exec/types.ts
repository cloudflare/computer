// Wire-compatible shapes for the exec surface. Mirrors docs/08
// (ExecEvent) and docs/05 (ExecHandle) but stays internal to computerd
// until the computer-rpc surface (E2) picks them up.
//
// Every event carries a per-id monotonic `seq`. Resume math
// (`getExec({ after })`) is integer comparisons — a monotonic
// counter rather than a wall-clock timestamp avoids clock-skew
// and same-millisecond ordering issues.

export type HeartbeatValue = {
  // OS process id of the running child.
  pid: number;
  // Milliseconds since the exec started.
  elapsedMs: number;
  // Milliseconds since the last stdout or stderr chunk arrived.
  // Equal to elapsedMs when no output has been produced yet.
  lastOutputMs: number;
};

export type ExecEvent =
  | { id: string; seq: number; name: "stdout"; value: Uint8Array }
  | { id: string; seq: number; name: "stderr"; value: Uint8Array }
  | { id: string; seq: number; name: "exit"; value: number }
  | { id: string; seq: number; name: "heartbeat"; value: HeartbeatValue };

export interface ExecOptions {
  // Caller-supplied id. If omitted the runner mints one. Reusing
  // an id while a previous run is still active throws.
  id?: string;
  // Absolute path inside the container. Defaults to the runner's
  // configured cwd (typically the workspace root).
  cwd?: string;
  // Per-call timeout. After this many milliseconds the runner
  // sends SIGTERM (then SIGKILL after a short grace) to the
  // child. A value of 0 disables the timeout for this call.
  // Omit to use the runner's defaultTimeoutMs.
  timeoutMs?: number;
  // Inherited by the child. Merged on top of the runner's base env.
  env?: Record<string, string>;
}

export interface RunnerOptions {
  // Default working directory for exec(). Overridden per-call.
  cwd?: string;
  // Base env merged into every spawned child.
  env?: Record<string, string>;
  // Per-exec log cap. Past this many bytes the log is evicted
  // and future getExec calls throw ELOG_TRUNCATED. Default 16 MiB.
  // The live stream is unaffected by eviction.
  logMaxBytes?: number;
  // Retain a completed exec's log for at most this long after
  // exit. Eviction also fires on explicit dispose() or on
  // size-cap overflow. Default 5 min.
  retentionMs?: number;
  // How often to scan for expired records. Default 30 s.
  sweepIntervalMs?: number;
  // Default exec timeout (ms). Per-call timeoutMs overrides this.
  // 0 disables the default; omit to use the built-in 320_000.
  defaultTimeoutMs?: number;
  // Emit a heartbeat event every this many milliseconds while a child
  // process is alive. When unset or zero, no heartbeat events are emitted.
  heartbeatIntervalMs?: number;
  // Test seam: replaces Date.now() for retention math and log ts.
  now?: () => number;
}

// Error codes the runner can raise. Mirrored on the wire (docs/08)
// and rethrown host-side as WorkspaceError.code.
export type ExecErrorCode =
  // Reused an id while its previous run was still active, or two
  // subscribers attached to the same live exec.
  | "EEXEC_BUSY"
  // getExec for an id the runner has no record of (never
  // existed, or already disposed).
  | "ENOENT"
  // getExec resume point is older than the retained log, or the
  // log was evicted by size cap.
  | "ELOG_TRUNCATED";

export class ExecError extends Error {
  readonly code: ExecErrorCode;
  constructor(code: ExecErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ExecError";
  }
}
