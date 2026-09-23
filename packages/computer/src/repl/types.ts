// Public result shape of a REPL evaluation.
//
// Follows the common interpreter-result convention (`results[]`, `error`,
// per-cell logs), extended with:
//   - `value`: the cell's actual JavaScript completion value (structured
//     clone), for programs rather than humans.
//   - `logs.entries`: one ordered stream with console levels preserved,
//     instead of split stdout/stderr streams that lose interleaving.
//   - structured error kinds that name their own remediation.

export interface ReplResultData {
  /** Inspect-style text rendering of an output. */
  text: string;
}

export type ReplLogLevel = "log" | "info" | "debug" | "warn" | "error";

export interface ReplLogEntry {
  level: ReplLogLevel;
  text: string;
}

export type ReplErrorKind =
  /**
   * Replaying the session's committed cells no longer reproduces the
   * recorded effect log — the log and the code disagree (storage was
   * altered, or an unrecorded nondeterminism source leaked in). The
   * failing eval was not committed; earlier committed state is untouched.
   */
  | "replay-divergence"
  /**
   * The cell exceeded its wall-clock or CPU budget and was destroyed.
   * Nothing was committed; split the work or raise timeoutMs.
   */
  | "timeout"
  /**
   * New code used a handle whose live object died with a session host
   * restart. The error message carries the handle's acquisition recipe —
   * re-run it to get a fresh handle. Committed cells replay from the log
   * and never hit this.
   */
  | "stale-lease"
  /**
   * New code called a capability that is not granted in the current
   * attachment — either directly, or through a handle descending from a
   * root grant that was since revoked. Grants are attach-time: the host
   * must re-attach the session with the capability before new code can
   * use it.
   */
  | "not-granted"
  /**
   * A capability call returned more than the per-call recorded ceiling.
   * Recorded values are replay input and are never truncated, so the cell
   * failed instead. Write large data to workspace files and return a path.
   */
  | "oversized-result";

export interface ReplExecutionError {
  name: string;
  message: string;
  /** Stack trace, when the failure came from running cell code. */
  traceback?: string;
  /**
   * Structured kind for failures with defined semantics. Absent for
   * ordinary runtime errors thrown by cell code.
   */
  kind?: ReplErrorKind;
}

export interface ReplExecutionResult {
  /** The cell source as submitted. */
  code: string;
  /**
   * The cell's completion value: explicit top-level `return` if present,
   * else the trailing expression, else undefined. Omitted (key absent)
   * when the value cannot cross the boundary as a structured clone —
   * the cell still succeeds and `results` carries a rendering.
   */
  value?: unknown;
  /**
   * Console output from the new cell, in emission order with levels
   * preserved. `dropped` counts entries discarded past the cap.
   */
  logs: { entries: ReplLogEntry[]; dropped?: number };
  /** Display renderings (e.g. of an unclonable value). */
  results: ReplResultData[];
  error?: ReplExecutionError;
  /** 1-based cell sequence (the would-be sequence for failed cells). */
  executionCount: number;
}

/** One recorded nondeterministic effect (host-boundary call result). */
export interface ReplEffect {
  kind: string;
  value: unknown;
}
