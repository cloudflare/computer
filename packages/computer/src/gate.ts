/**
 * Approval seams: a gate that runs before an action and an audit hook
 * that runs after it.
 *
 * These exist because the observer in `./observe.ts` deliberately
 * cannot do this job. Its contract says an implementation "must run
 * `run` synchronously and return its result unchanged so the wrapping
 * is invisible to the caller" — observability that changes behaviour
 * is a bug. A gate is the opposite: its whole purpose is to refuse.
 * Rather than weaken the observer contract, this is a second seam with
 * the same shape and the opposite licence.
 *
 * The split into two hooks matches what each one is for. The gate
 * decides, so it runs before the action and sees only the request. The
 * audit records, so it runs after and sees the outcome. An audit hook
 * cannot deny anything; if it throws, the action has already happened
 * and the throw is swallowed, exactly as `withSpan` treats a failing
 * `finalize`.
 *
 * Both default to no-ops, so a caller who does not opt in pays one
 * comparison per action.
 *
 * ## Why a command is gated once, not per write
 *
 * The gate fires once for a whole `shell.exec`, and the decision
 * covers every write that command makes. It is tempting to instead
 * check each write as it happens, but that produces worse outcomes
 * than refusing the command outright: `rm -rf` issues one call per
 * entry, so denying halfway leaves a half-deleted tree. A command is
 * the smallest unit that can be refused and leave the workspace in a
 * state the caller can reason about.
 *
 * The same reasoning rules out asking a human mid-command. By the time
 * a write arrives the command is running, and there is nowhere to
 * suspend it that does not risk a partial result. A gate that wants
 * human approval must ask before the command starts, which is where
 * this one runs.
 *
 * Filesystem actions are gated per call, because there each call is
 * the whole action and refusing one leaves nothing half-done.
 */

/**
 * What is about to happen, in enough detail for a gate to decide.
 *
 * Discriminated on `kind`. A gate that only cares about one kind
 * should switch on it and return `allowed` for the rest, so new kinds
 * added later stay permitted rather than silently breaking callers who
 * were never asked about them.
 */
export type WorkspaceAction =
  | {
      kind: "shell.exec";
      // The command line as it will be handed to the runner.
      command: string;
      cwd?: string;
      // Whether the caller is asking for write access. A gate can
      // narrow this to false in its decision; it cannot widen it.
      writable: boolean;
      // Which registered backend will run this, once resolved.
      backend?: string;
    }
  | {
      kind: "fs.write" | "fs.mkdir" | "fs.rm" | "fs.chmod" | "fs.symlink";
      // Absolute path inside the workspace.
      path: string;
      // Byte length for a write, when known. Absent for the others.
      size?: number;
    };

/** The action kinds, for callers that want to switch exhaustively. */
export type WorkspaceActionKind = WorkspaceAction["kind"];

/**
 * A gate's answer.
 *
 * `allow: true` may carry `writable: false` to permit the action with
 * write access withdrawn — the useful middle answer for a command a
 * policy is willing to run but not to trust with the workspace. A gate
 * can only narrow write access this way. Passing `writable: true` for
 * an action that did not ask for it does not grant it.
 *
 * `allow: false` refuses. `reason` is surfaced to the caller and
 * should be phrased for whoever asked for the action, since that is
 * who will read it.
 */
export type GateDecision = { allow: true; writable?: boolean } | { allow: false; reason?: string };

/**
 * Consulted before an action runs.
 *
 * May be async: a gate is allowed to consult a policy service or wait
 * for a human, and the action does not start until it settles. Keep in
 * mind that whatever it waits on holds up the caller.
 *
 * A gate that throws denies the action. The error propagates to the
 * caller unchanged rather than being converted into a refusal, because
 * a gate that failed to reach a decision is not the same as a gate
 * that decided no, and a caller who cannot tell those apart will
 * eventually treat an outage as permission.
 */
export interface WorkspaceGate {
  check(action: WorkspaceAction): Promise<GateDecision> | GateDecision;
}

/** The outcome of a gated action, as reported to an audit hook. */
export type AuditOutcome =
  | { status: "allowed"; writable: boolean }
  | { status: "denied"; reason?: string }
  // The action ran and threw. `error` is whatever it threw.
  | { status: "failed"; error: unknown };

/**
 * Notified after an action has been decided and, if allowed, run.
 *
 * Fires for denied actions too — a record of what was refused is
 * usually the more interesting half. Errors thrown here are
 * swallowed: the action has already happened, and failing the caller
 * over a failed log entry would turn an audit hook into a gate.
 */
export interface WorkspaceAudit {
  record(action: WorkspaceAction, outcome: AuditOutcome): void | Promise<void>;
}

/** Gate that permits everything, used when the caller passes none. */
export const openGate: WorkspaceGate = {
  check() {
    return ALLOWED;
  },
};

const ALLOWED: GateDecision = { allow: true };

/** Audit hook that records nothing, used when the caller passes none. */
export const noopAudit: WorkspaceAudit = {
  record() {
    // intentionally empty
  },
};

/**
 * Thrown when a gate refuses an action.
 *
 * Carries the action so a caller catching it can report what was
 * refused without having to remember what it asked for.
 */
export class ActionDeniedError extends Error {
  readonly action: WorkspaceAction;
  readonly reason?: string;

  constructor(action: WorkspaceAction, reason?: string) {
    super(reason ? `${action.kind} denied: ${reason}` : `${action.kind} denied`);
    this.name = "ActionDeniedError";
    this.action = action;
    this.reason = reason;
  }
}

/**
 * Internal helper: consult `gate`, run `action` if allowed, and report
 * the outcome to `audit`. Mirrors `withSpan` in `./observe.ts` so the
 * two seams read the same way at a call site that uses both.
 *
 * `run` receives the effective write access, which is the requested
 * access narrowed by whatever the gate decided. Call sites should use
 * that argument rather than the flag they passed in, since ignoring it
 * is how a narrowed decision gets quietly dropped.
 *
 * Throws `ActionDeniedError` when the gate refuses. Nothing runs in
 * that case.
 */
export async function withGate<T>(
  gate: WorkspaceGate,
  audit: WorkspaceAudit,
  action: WorkspaceAction,
  run: (writable: boolean) => Promise<T>,
): Promise<T> {
  const requested = action.kind === "shell.exec" ? action.writable : true;
  const decision = await gate.check(action);

  if (!decision.allow) {
    await reportSafely(audit, action, { status: "denied", reason: decision.reason });
    throw new ActionDeniedError(action, decision.reason);
  }

  // The gate can narrow write access but not widen it, so a decision
  // asking for more than the action requested is capped rather than
  // honoured.
  const writable = requested && (decision.writable ?? true);

  try {
    const value = await run(writable);
    await reportSafely(audit, action, { status: "allowed", writable });
    return value;
  } catch (error) {
    await reportSafely(audit, action, { status: "failed", error });
    throw error;
  }
}

// An audit hook that throws must not change the outcome of work that
// has already happened. Rejections are swallowed here for the same
// reason withSpan swallows a failing finalize.
async function reportSafely(
  audit: WorkspaceAudit,
  action: WorkspaceAction,
  outcome: AuditOutcome,
): Promise<void> {
  try {
    await audit.record(action, outcome);
  } catch {
    // not actionable: the action's outcome is already decided
  }
}
