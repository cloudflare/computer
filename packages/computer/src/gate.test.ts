import { describe, expect, it, vi } from "vitest";

import {
  ActionDeniedError,
  type AuditOutcome,
  noopAudit,
  openGate,
  type WorkspaceAction,
  type WorkspaceAudit,
  type WorkspaceGate,
  withGate,
} from "./gate.js";

function execAction(writable = true): WorkspaceAction {
  return { kind: "shell.exec", command: "ls", writable };
}

function recordingAudit(): WorkspaceAudit & { entries: [WorkspaceAction, AuditOutcome][] } {
  const entries: [WorkspaceAction, AuditOutcome][] = [];
  return {
    entries,
    record(action, outcome) {
      entries.push([action, outcome]);
    },
  };
}

function gateReturning(decision: Awaited<ReturnType<WorkspaceGate["check"]>>): WorkspaceGate {
  return { check: () => decision };
}

describe("withGate", () => {
  it("runs the action and reports it when the gate allows", async () => {
    const audit = recordingAudit();
    const result = await withGate(openGate, audit, execAction(), async () => "ran");

    expect(result).toBe("ran");
    expect(audit.entries).toEqual([[execAction(), { status: "allowed", writable: true }]]);
  });

  it("does not run the action when the gate denies", async () => {
    const audit = recordingAudit();
    const run = vi.fn(async () => "ran");
    const gate = gateReturning({ allow: false, reason: "not on the allowlist" });

    await expect(withGate(gate, audit, execAction(), run)).rejects.toThrow(ActionDeniedError);
    expect(run).not.toHaveBeenCalled();
    expect(audit.entries).toEqual([
      [execAction(), { status: "denied", reason: "not on the allowlist" }],
    ]);
  });

  it("carries the action and reason on the denial", async () => {
    const gate = gateReturning({ allow: false, reason: "needs approval" });
    const action = execAction();

    const error = await withGate(gate, noopAudit, action, async () => "ran").catch((e) => e);

    expect(error).toBeInstanceOf(ActionDeniedError);
    expect(error.action).toEqual(action);
    expect(error.reason).toBe("needs approval");
    expect(error.message).toBe("shell.exec denied: needs approval");
  });

  it("narrows write access when the gate withdraws it", async () => {
    // The useful middle answer: run the command, but not with write
    // access. The callback must see the narrowed value.
    const audit = recordingAudit();
    const gate = gateReturning({ allow: true, writable: false });
    const seen: boolean[] = [];

    await withGate(gate, audit, execAction(true), async (writable) => {
      seen.push(writable);
    });

    expect(seen).toEqual([false]);
    expect(audit.entries[0][1]).toEqual({ status: "allowed", writable: false });
  });

  it("cannot widen write access the action did not ask for", async () => {
    // A gate is a restriction, not a grant. Allowing it to hand out
    // access the caller never requested would make a read-only exec
    // depend on the gate's good behaviour.
    const audit = recordingAudit();
    const gate = gateReturning({ allow: true, writable: true });
    const seen: boolean[] = [];

    await withGate(gate, audit, execAction(false), async (writable) => {
      seen.push(writable);
    });

    expect(seen).toEqual([false]);
    expect(audit.entries[0][1]).toEqual({ status: "allowed", writable: false });
  });

  it("waits for an async gate before running the action", async () => {
    const order: string[] = [];
    const gate: WorkspaceGate = {
      async check() {
        order.push("gate-start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("gate-end");
        return { allow: true };
      },
    };

    await withGate(gate, noopAudit, execAction(), async () => {
      order.push("action");
    });

    expect(order).toEqual(["gate-start", "gate-end", "action"]);
  });

  it("propagates a gate that throws instead of treating it as a denial", async () => {
    // A gate that could not reach a decision is not a gate that said
    // no. Collapsing the two would let an outage read as permission
    // in one direction or as a policy refusal in the other.
    const failure = new Error("policy service unreachable");
    const gate: WorkspaceGate = {
      check() {
        throw failure;
      },
    };
    const run = vi.fn(async () => "ran");

    await expect(withGate(gate, noopAudit, execAction(), run)).rejects.toBe(failure);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a failed action and rethrows the original error", async () => {
    const audit = recordingAudit();
    const failure = new Error("command blew up");

    await expect(
      withGate(openGate, audit, execAction(), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(audit.entries).toEqual([[execAction(), { status: "failed", error: failure }]]);
  });

  it("does not let a throwing audit hook change a successful outcome", async () => {
    const audit: WorkspaceAudit = {
      record() {
        throw new Error("log sink down");
      },
    };

    await expect(withGate(openGate, audit, execAction(), async () => "ran")).resolves.toBe("ran");
  });

  it("does not let a rejecting audit hook change a successful outcome", async () => {
    const audit: WorkspaceAudit = {
      record() {
        return Promise.reject(new Error("log sink down"));
      },
    };

    await expect(withGate(openGate, audit, execAction(), async () => "ran")).resolves.toBe("ran");
  });

  it("still denies when the audit hook throws on a denial", async () => {
    const audit: WorkspaceAudit = {
      record() {
        throw new Error("log sink down");
      },
    };
    const gate = gateReturning({ allow: false });

    await expect(withGate(gate, audit, execAction(), async () => "ran")).rejects.toThrow(
      ActionDeniedError,
    );
  });

  it("treats filesystem actions as write actions regardless of decision shape", async () => {
    const audit = recordingAudit();
    const action: WorkspaceAction = { kind: "fs.rm", path: "/workspace/a.txt" };

    await withGate(openGate, audit, action, async (writable) => {
      expect(writable).toBe(true);
    });

    expect(audit.entries).toEqual([[action, { status: "allowed", writable: true }]]);
  });

  it("gates each filesystem call separately", async () => {
    // Per-call gating is safe for fs actions because each call is the
    // whole action. This is the contrast with shell.exec, which is
    // gated once for the command.
    const seen: string[] = [];
    const gate: WorkspaceGate = {
      check(action) {
        if (action.kind !== "shell.exec") seen.push(`${action.kind}:${action.path}`);
        return { allow: true };
      },
    };

    await withGate(gate, noopAudit, { kind: "fs.write", path: "/a", size: 1 }, async () => {});
    await withGate(gate, noopAudit, { kind: "fs.rm", path: "/b" }, async () => {});

    expect(seen).toEqual(["fs.write:/a", "fs.rm:/b"]);
  });

  it("passes the open gate and noop audit through without allocating a decision per call", async () => {
    // The default path should be cheap: the point of the no-op
    // defaults is that a caller who does not opt in pays nothing
    // beyond a comparison.
    const first = await openGate.check(execAction());
    const second = await openGate.check(execAction());

    expect(first).toBe(second);
    expect(noopAudit.record(execAction(), { status: "allowed", writable: true })).toBeUndefined();
  });
});
