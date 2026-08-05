import type { AuditOutcome, WorkspaceAction } from "@cloudflare/computer";
import type { ExecWorkspaceLike } from "@cloudflare/computer/tools";
import { describe, expect, it } from "vitest";

import {
  createAgentTools,
  createApprovalGate,
  createAudit,
  DEFAULT_BACKEND,
  EXEC_BACKENDS,
  execApproval,
} from "./agent.js";
import { type ApprovalPolicy, DEFAULT_APPROVAL_POLICY } from "./approval-policy.js";

interface ExecCall {
  command: string;
  backend: string | undefined;
  writable: boolean | undefined;
}

/**
 * Enough of a workspace to build the toolset against. `fs` is only
 * here because createAITools reaches for it while wiring the read and
 * list tools; nothing in this file calls it.
 */
function fakeWorkspace(): ExecWorkspaceLike & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    fs: {},
    runtime: {
      async exec(command: string, options: { backend?: string; writable?: boolean }) {
        calls.push({ command, backend: options.backend, writable: options.writable });
        return { result: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
      },
    },
  } as unknown as ExecWorkspaceLike & { calls: ExecCall[] };
}

async function exec(
  workspace: ExecWorkspaceLike & { calls: ExecCall[] },
  input: { command: string; backend?: string },
  policy?: ApprovalPolicy,
): Promise<Record<string, unknown>> {
  const tools = createAgentTools({
    workspace: workspace as unknown as Parameters<typeof createAgentTools>[0]["workspace"],
    policy,
  });
  const execute = tools.exec.execute as (
    i: typeof input,
    o: unknown,
  ) => Promise<Record<string, unknown>>;
  return execute(input, {});
}

describe("the invariant", () => {
  // The claim the whole example rests on: write access and human
  // attention are the same decision, so neither can drift from the
  // other without this failing.
  //
  // `execute` standing in for an approved call is exactly what the AI
  // SDK does — it does not call `execute` until approval has been
  // granted — so reaching this line at all means the human said yes.
  it("gives write access to exactly the commands that need approval", async () => {
    const commands = [
      "cat /workspace/a.txt",
      "ls -la /workspace",
      "find /workspace -name '*.ts'",
      "rm -rf /workspace/sub",
      "find /workspace -mindepth 1 -delete",
      "npm install",
      "echo hi > /workspace/out",
    ];

    for (const command of commands) {
      const ws = fakeWorkspace();
      const result = await exec(ws, { command });
      const needsApproval = execApproval()({ command }) === "user-approval";

      expect(ws.calls[0].writable, command).toBe(needsApproval);
      // Reported back to the model too, so it can tell a refused write
      // from a broken command.
      expect(result.writable, command).toBe(needsApproval);
    }
  });

  it("holds on every backend, not just the one with the matcher", async () => {
    // The two gated backends approve everything, so everything that
    // runs on them runs writable; worker-shell is the only one where
    // the answer varies by command.
    for (const backend of ["worker-javascript", "container-shell"]) {
      const ws = fakeWorkspace();
      await exec(ws, { command: "cat /workspace/a.txt", backend });
      expect(ws.calls[0].writable, backend).toBe(true);
    }

    const ws = fakeWorkspace();
    await exec(ws, { command: "cat /workspace/a.txt", backend: "worker-shell" });
    expect(ws.calls[0].writable).toBe(false);
  });

  it("tracks the policy rather than a copy of it", async () => {
    // Flip the shell to "always" and the same read now costs a
    // question, so it also gains write access. One decision, not two.
    const policy: ApprovalPolicy = { rules: { "worker-shell": "always" }, fallback: "always" };
    const ws = fakeWorkspace();
    await exec(ws, { command: "cat /workspace/a.txt" }, policy);
    expect(ws.calls[0].writable).toBe(true);
  });
});

describe("createAgentTools", () => {
  it("offers no tool that writes except exec", () => {
    // One door for mutation. A `write` or `edit` tool alongside the
    // approval flow would let the model change files without any of it
    // being consulted.
    const tools = createAgentTools({
      workspace: fakeWorkspace() as unknown as Parameters<typeof createAgentTools>[0]["workspace"],
    });
    expect(Object.keys(tools).sort()).toEqual(["exec", "ls", "read"]);
  });

  it("describes every backend the workspace registers", () => {
    expect(Object.keys(EXEC_BACKENDS).sort()).toEqual([
      "container-shell",
      "worker-javascript",
      "worker-shell",
    ]);
    expect(EXEC_BACKENDS).toHaveProperty(DEFAULT_BACKEND);
  });
});

describe("execApproval", () => {
  it("asks about a command the matcher cannot vouch for", () => {
    expect(execApproval()({ command: "rm -rf /workspace" })).toBe("user-approval");
  });

  it("stays out of the way for a recognized read", () => {
    expect(execApproval()({ command: "cat /workspace/a.txt" })).toBe("not-applicable");
  });

  it("reads the default backend when the model names none", () => {
    // The default is the one backend with a matcher, so omitting it has
    // to mean that rather than falling through to the strict fallback.
    expect(execApproval()({ command: "cat /workspace/a.txt" })).toBe("not-applicable");
    expect(execApproval()({ command: "cat /workspace/a.txt", backend: "container-shell" })).toBe(
      "user-approval",
    );
  });
});

describe("createApprovalGate", () => {
  const gate = createApprovalGate();

  function check(action: WorkspaceAction) {
    return gate.check(action);
  }

  it("allows an action it was never asked about", () => {
    // A kind added to the seam later should stay permitted rather than
    // break a caller who was never consulted about it.
    expect(check({ kind: "fs.write", path: "/workspace/a.txt", size: 4 })).toEqual({ allow: true });
    expect(check({ kind: "fs.rm", path: "/workspace/a.txt" })).toEqual({ allow: true });
  });

  it("allows a command that is already asking for nothing", () => {
    expect(check({ kind: "shell.exec", command: "rm -rf /workspace", writable: false })).toEqual({
      allow: true,
    });
  });

  it("allows write access to a command the matcher would have asked about", () => {
    // The only route to write access is an approval, so a command in
    // this shape has already been through one.
    expect(
      check({
        kind: "shell.exec",
        command: "rm -rf /workspace",
        writable: true,
        backend: "worker-shell",
      }),
    ).toEqual({ allow: true });
  });

  it("narrows write access that no approval could have justified", () => {
    // A recognized read never needed write access, so nothing upstream
    // asked a human about it. Write access here means it arrived by
    // some other route, and taking it away costs the caller nothing
    // the matcher says it needed.
    expect(
      check({
        kind: "shell.exec",
        command: "cat /workspace/a.txt",
        writable: true,
        backend: "worker-shell",
      }),
    ).toEqual({ allow: true, writable: false });
  });

  it("assumes the default backend when the action does not name one", () => {
    // The pull path and any caller that skipped backend resolution
    // land here. Reading it as the default is what keeps the matcher
    // applying to the backend the matcher is for.
    expect(check({ kind: "shell.exec", command: "cat /workspace/a.txt", writable: true })).toEqual({
      allow: true,
      writable: false,
    });
  });

  it("never refuses outright", async () => {
    // A gate cannot ask a human — by the time the action exists there
    // is nowhere to suspend it — and refusing a command the model was
    // told it could run turns a policy question into an unexplained
    // failure. Narrowing is the answer it has.
    for (const command of ["cat /workspace/a.txt", "rm -rf /", "frobnicate"]) {
      for (const writable of [true, false]) {
        const decision = await check({ kind: "shell.exec", command, writable });
        expect(decision.allow, command).toBe(true);
      }
    }
  });

  it("honours a policy other than the default", async () => {
    const trusting = createApprovalGate({ rules: { "worker-shell": "never" }, fallback: "always" });
    // Under "never" nothing needs approval, so nothing justifies write
    // access and every command is narrowed.
    expect(
      await trusting.check({ kind: "shell.exec", command: "rm -rf /workspace", writable: true }),
    ).toEqual({ allow: true, writable: false });
  });
});

describe("createAudit", () => {
  const action: WorkspaceAction = {
    kind: "shell.exec",
    command: "rm -rf /workspace",
    writable: true,
  };

  function auditWith(outcome: AuditOutcome) {
    const audit = createAudit({});
    audit.record(action, outcome);
    return audit.records()[0];
  }

  it("records what ran and whether it could write", () => {
    const record = auditWith({ status: "allowed", writable: true });
    expect(record.kind).toBe("shell.exec");
    expect(record.target).toBe("rm -rf /workspace");
    expect(record.status).toBe("allowed");
    expect(record.writable).toBe(true);
  });

  it("records a refusal and why", () => {
    const record = auditWith({ status: "denied", reason: "no" });
    expect(record.status).toBe("denied");
    expect(record.detail).toBe("no");
    // Write access is not a fact about an action that never ran.
    expect(record.writable).toBeUndefined();
  });

  it("records a failure with the message rather than the error", () => {
    const record = auditWith({ status: "failed", error: new Error("EROFS") });
    expect(record.status).toBe("failed");
    expect(record.detail).toBe("EROFS");
  });

  it("names a filesystem action by its path", () => {
    const audit = createAudit({});
    audit.record(
      { kind: "fs.write", path: "/workspace/a.txt", size: 4 },
      {
        status: "allowed",
        writable: true,
      },
    );
    expect(audit.records()[0].target).toBe("/workspace/a.txt");
  });

  it("hands each record to the sink as it happens", () => {
    const seen: string[] = [];
    const audit = createAudit({ sink: (record) => seen.push(record.target) });
    audit.record(action, { status: "allowed", writable: true });
    expect(seen).toEqual(["rm -rf /workspace"]);
  });

  it("keeps the trail bounded", () => {
    // A log is not a database. An audit hook that grows without limit
    // inside a durable object is a memory leak with good intentions.
    const audit = createAudit({ limit: 3 });
    for (const command of ["one", "two", "three", "four"]) {
      audit.record(
        { kind: "shell.exec", command, writable: false },
        {
          status: "allowed",
          writable: false,
        },
      );
    }
    expect(audit.records().map((record) => record.target)).toEqual(["two", "three", "four"]);
  });

  it("hands out a copy, so a reader cannot edit the trail", () => {
    const audit = createAudit({});
    audit.record(action, { status: "allowed", writable: true });
    audit.records().length = 0;
    expect(audit.records()).toHaveLength(1);
  });
});

describe("the default policy and the tools agree", () => {
  it("has a rule for every backend the model can name", () => {
    // A backend the model can pick but the policy has no rule for
    // falls back to "always": safe, but it costs a human every command
    // and nobody meant to configure that.
    for (const backend of Object.keys(EXEC_BACKENDS)) {
      expect(DEFAULT_APPROVAL_POLICY.rules, backend).toHaveProperty(backend);
    }
  });
});
