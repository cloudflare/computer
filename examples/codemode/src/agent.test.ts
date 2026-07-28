import type { LanguageModelV3Content } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { MAX_STEPS, runAgentTurn } from "./agent.js";
import type { ApprovalPolicy } from "./approval-policy.js";
import { decideApproval } from "./approval-policy.js";
import type { ExecWorkspaceLike } from "./tools/exec.js";

// ---------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------

const READ = "cat /workspace/hello.txt";
const WRITE = "rm -rf /workspace";

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

function execCall(
  toolCallId: string,
  input: { command: string; backend?: string; cwd?: string },
): LanguageModelV3Content {
  return { type: "tool-call", toolCallId, toolName: "exec", input: JSON.stringify(input) };
}

function say(text: string): LanguageModelV3Content {
  return { type: "text", text };
}

/**
 * A model that replays scripted responses, one per `generateText`
 * call. The same instance is reused across a pause and its resume, so
 * the script reads as the whole turn.
 */
function scriptedModel(script: LanguageModelV3Content[][]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const content = script[Math.min(call, script.length - 1)];
      call += 1;
      const callsTool = content.some((part) => part.type === "tool-call");
      return {
        content,
        finishReason: { unified: callsTool ? "tool-calls" : "stop", raw: undefined },
        usage: usage(),
        warnings: [],
      };
    },
  });
}

interface RecordedExec {
  command: string;
  backend: string | undefined;
  cwd: string | undefined;
}

function fakeWorkspace(): { workspace: ExecWorkspaceLike; calls: RecordedExec[] } {
  const calls: RecordedExec[] = [];
  const workspace: ExecWorkspaceLike = {
    shell: {
      exec: async (command, options) => {
        calls.push({ command, backend: options.backend, cwd: options.cwd });
        return {
          result: async () => ({ exitCode: 0, stdout: `ran: ${command}`, stderr: "" }),
        };
      },
    },
  };
  return { workspace, calls };
}

const env = {} as Env;

// ---------------------------------------------------------------

describe("runAgentTurn", () => {
  describe("commands that need no approval", () => {
    it("runs a read and finishes the turn", async () => {
      const { workspace, calls } = fakeWorkspace();
      const model = scriptedModel([
        [execCall("c1", { command: READ, backend: "shell" })],
        [say("done")],
      ]);

      const transcript = await runAgentTurn({ env, workspace, model, prompt: "read the file" });

      expect(transcript.status).toBe("completed");
      expect(transcript.pendingApprovals).toEqual([]);
      expect(calls).toEqual([{ command: READ, backend: "shell", cwd: undefined }]);
      expect(transcript.toolCalls).toHaveLength(1);
      expect(transcript.toolCalls[0]).toMatchObject({
        command: READ,
        backend: "shell",
        exitCode: 0,
        stdout: `ran: ${READ}`,
      });
      expect(transcript.text).toBe("done");
    });

    it("honours a policy that trusts a backend outright", async () => {
      // Same mutating command, different policy: the gate is
      // configuration, not a hardcoded list.
      const trusting: ApprovalPolicy = { rules: { shell: "never" }, fallback: "always" };
      const { workspace, calls } = fakeWorkspace();
      const model = scriptedModel([
        [execCall("c1", { command: WRITE, backend: "shell" })],
        [say("removed")],
      ]);

      const transcript = await runAgentTurn({
        env,
        workspace,
        model,
        prompt: "delete it",
        policy: trusting,
      });

      expect(transcript.status).toBe("completed");
      expect(calls).toHaveLength(1);
    });
  });

  describe("commands that need approval", () => {
    it("pauses without running the command", async () => {
      const { workspace, calls } = fakeWorkspace();
      const model = scriptedModel([[execCall("c1", { command: WRITE, backend: "shell" })]]);

      const transcript = await runAgentTurn({ env, workspace, model, prompt: "delete it" });

      expect(transcript.status).toBe("awaiting-approval");
      // The whole point: nothing ran.
      expect(calls).toEqual([]);
      expect(transcript.toolCalls).toEqual([]);
      expect(transcript.pendingApprovals).toHaveLength(1);
      expect(transcript.pendingApprovals[0]).toMatchObject({
        toolCallId: "c1",
        command: WRITE,
        backend: "shell",
        cwd: null,
      });
      expect(transcript.pendingApprovals[0].approvalId.length).toBeGreaterThan(0);
    });

    it("explains the pause with the same reason the policy gave", async () => {
      const { workspace } = fakeWorkspace();
      const model = scriptedModel([[execCall("c1", { command: WRITE, backend: "shell" })]]);

      const transcript = await runAgentTurn({ env, workspace, model, prompt: "delete it" });

      expect(transcript.pendingApprovals[0].reason).toBe(
        decideApproval({ command: WRITE, backend: "shell" }).reason,
      );
    });

    it("reports the backend the model chose, not the default", async () => {
      const { workspace } = fakeWorkspace();
      const model = scriptedModel([
        [execCall("c1", { command: "uname -a", backend: "container" })],
      ]);

      const transcript = await runAgentTurn({ env, workspace, model, prompt: "which kernel?" });

      expect(transcript.pendingApprovals[0].backend).toBe("container");
    });

    it("falls back to the default backend when the model omits one", async () => {
      const { workspace } = fakeWorkspace();
      const model = scriptedModel([[execCall("c1", { command: WRITE })]]);

      const transcript = await runAgentTurn({ env, workspace, model, prompt: "delete it" });

      expect(transcript.pendingApprovals[0].backend).toBe("shell");
    });

    it("keeps the work it already did before pausing", async () => {
      const { workspace, calls } = fakeWorkspace();
      const model = scriptedModel([
        [execCall("c1", { command: READ, backend: "shell" })],
        [execCall("c2", { command: WRITE, backend: "shell" })],
      ]);

      const transcript = await runAgentTurn({ env, workspace, model, prompt: "read then delete" });

      expect(transcript.status).toBe("awaiting-approval");
      expect(calls.map((call) => call.command)).toEqual([READ]);
      expect(transcript.toolCalls.map((call) => call.command)).toEqual([READ]);
    });
  });

  describe("the resume spine", () => {
    it("survives a round trip through JSON", async () => {
      const { workspace } = fakeWorkspace();
      const model = scriptedModel([
        [execCall("c1", { command: WRITE, backend: "shell" })],
        [say("removed")],
      ]);

      const paused = await runAgentTurn({ env, workspace, model, prompt: "delete it" });
      // This is the assumption the durable object depends on: the
      // messages are plain data, storable and retrievable verbatim.
      const rehydrated = JSON.parse(JSON.stringify(paused.messages));
      expect(rehydrated).toEqual(paused.messages);

      const resumed = await runAgentTurn({
        env,
        workspace,
        model,
        resume: {
          messages: rehydrated,
          approvals: [{ approvalId: paused.pendingApprovals[0].approvalId, approved: true }],
        },
      });

      expect(resumed.status).toBe("completed");
    });

    it("grows with each pass so a second pause can be resumed too", async () => {
      const { workspace } = fakeWorkspace();
      const model = scriptedModel([
        [execCall("c1", { command: WRITE, backend: "shell" })],
        [execCall("c2", { command: "mkdir /workspace/d", backend: "shell" })],
        [say("done")],
      ]);

      const first = await runAgentTurn({ env, workspace, model, prompt: "delete then make" });
      const second = await runAgentTurn({
        env,
        workspace,
        model,
        resume: {
          messages: first.messages,
          approvals: [{ approvalId: first.pendingApprovals[0].approvalId, approved: true }],
        },
      });

      expect(second.status).toBe("awaiting-approval");
      expect(second.messages.length).toBeGreaterThan(first.messages.length);

      const third = await runAgentTurn({
        env,
        workspace,
        model,
        resume: {
          messages: second.messages,
          approvals: [{ approvalId: second.pendingApprovals[0].approvalId, approved: true }],
        },
      });

      expect(third.status).toBe("completed");
    });
  });

  describe("resuming with an approval", () => {
    it("runs the command that was held back", async () => {
      const { workspace, calls } = fakeWorkspace();
      const model = scriptedModel([
        [execCall("c1", { command: WRITE, backend: "shell" })],
        [say("removed")],
      ]);

      const paused = await runAgentTurn({ env, workspace, model, prompt: "delete it" });
      const resumed = await runAgentTurn({
        env,
        workspace,
        model,
        resume: {
          messages: paused.messages,
          approvals: [{ approvalId: paused.pendingApprovals[0].approvalId, approved: true }],
        },
      });

      expect(resumed.status).toBe("completed");
      expect(calls).toEqual([{ command: WRITE, backend: "shell", cwd: undefined }]);
      expect(resumed.text).toBe("removed");
    });

    it("reports the approved command in the transcript", async () => {
      // An approved call executes before the first model call of the
      // resumed pass, so it lands in no step. Reading the transcript
      // off the steps would lose it entirely.
      const { workspace } = fakeWorkspace();
      const model = scriptedModel([
        [execCall("c1", { command: WRITE, backend: "shell" })],
        [say("removed")],
      ]);

      const paused = await runAgentTurn({ env, workspace, model, prompt: "delete it" });
      const resumed = await runAgentTurn({
        env,
        workspace,
        model,
        resume: {
          messages: paused.messages,
          approvals: [{ approvalId: paused.pendingApprovals[0].approvalId, approved: true }],
        },
      });

      expect(resumed.toolCalls).toHaveLength(1);
      expect(resumed.toolCalls[0]).toMatchObject({
        command: WRITE,
        backend: "shell",
        exitCode: 0,
        stdout: `ran: ${WRITE}`,
      });
    });
  });

  describe("resuming with a rejection", () => {
    it("does not run the command", async () => {
      const { workspace, calls } = fakeWorkspace();
      const model = scriptedModel([
        [execCall("c1", { command: WRITE, backend: "shell" })],
        [say("understood, leaving it alone")],
      ]);

      const paused = await runAgentTurn({ env, workspace, model, prompt: "delete it" });
      const resumed = await runAgentTurn({
        env,
        workspace,
        model,
        resume: {
          messages: paused.messages,
          approvals: [
            {
              approvalId: paused.pendingApprovals[0].approvalId,
              approved: false,
              reason: "not now",
            },
          ],
        },
      });

      expect(calls).toEqual([]);
      expect(resumed.toolCalls).toEqual([]);
      expect(resumed.status).toBe("completed");
      expect(resumed.text).toBe("understood, leaving it alone");
    });

    it("tells the model the command was denied, and why", async () => {
      const { workspace } = fakeWorkspace();
      const model = scriptedModel([
        [execCall("c1", { command: WRITE, backend: "shell" })],
        [say("understood")],
      ]);

      const paused = await runAgentTurn({ env, workspace, model, prompt: "delete it" });
      await runAgentTurn({
        env,
        workspace,
        model,
        resume: {
          messages: paused.messages,
          approvals: [
            {
              approvalId: paused.pendingApprovals[0].approvalId,
              approved: false,
              reason: "not now",
            },
          ],
        },
      });

      const prompt = JSON.stringify(model.doGenerateCalls.at(-1)?.prompt);
      expect(prompt).toContain("execution-denied");
      expect(prompt).toContain("not now");
    });
  });

  describe("several approvals in one step", () => {
    it("pauses on each of them", async () => {
      const { workspace, calls } = fakeWorkspace();
      const model = scriptedModel([
        [
          execCall("c1", { command: WRITE, backend: "shell" }),
          execCall("c2", { command: "mkdir /workspace/d", backend: "shell" }),
        ],
      ]);

      const transcript = await runAgentTurn({ env, workspace, model, prompt: "delete and make" });

      expect(transcript.status).toBe("awaiting-approval");
      expect(transcript.pendingApprovals).toHaveLength(2);
      expect(transcript.pendingApprovals.map((entry) => entry.command)).toEqual([
        WRITE,
        "mkdir /workspace/d",
      ]);
      expect(calls).toEqual([]);
    });

    it("runs both once both are answered", async () => {
      const { workspace, calls } = fakeWorkspace();
      const model = scriptedModel([
        [
          execCall("c1", { command: WRITE, backend: "shell" }),
          execCall("c2", { command: "mkdir /workspace/d", backend: "shell" }),
        ],
        [say("both done")],
      ]);

      const paused = await runAgentTurn({ env, workspace, model, prompt: "delete and make" });
      const resumed = await runAgentTurn({
        env,
        workspace,
        model,
        resume: {
          messages: paused.messages,
          approvals: paused.pendingApprovals.map((entry) => ({
            approvalId: entry.approvalId,
            approved: true,
          })),
        },
      });

      expect(resumed.status).toBe("completed");
      expect(calls.map((call) => call.command)).toEqual([WRITE, "mkdir /workspace/d"]);
      expect(resumed.toolCalls).toHaveLength(2);
    });

    it("can approve one and deny the other", async () => {
      const { workspace, calls } = fakeWorkspace();
      const model = scriptedModel([
        [
          execCall("c1", { command: WRITE, backend: "shell" }),
          execCall("c2", { command: "mkdir /workspace/d", backend: "shell" }),
        ],
        [say("partly done")],
      ]);

      const paused = await runAgentTurn({ env, workspace, model, prompt: "delete and make" });
      const resumed = await runAgentTurn({
        env,
        workspace,
        model,
        resume: {
          messages: paused.messages,
          approvals: [
            { approvalId: paused.pendingApprovals[0].approvalId, approved: false, reason: "no" },
            { approvalId: paused.pendingApprovals[1].approvalId, approved: true },
          ],
        },
      });

      expect(calls.map((call) => call.command)).toEqual(["mkdir /workspace/d"]);
      expect(resumed.toolCalls).toHaveLength(1);
    });
  });

  describe("the step budget", () => {
    it("accumulates steps across passes", async () => {
      const { workspace } = fakeWorkspace();
      const model = scriptedModel([
        [execCall("c1", { command: READ, backend: "shell" })],
        [say("done")],
      ]);

      const transcript = await runAgentTurn({
        env,
        workspace,
        model,
        prompt: "read it",
        stepsUsed: 3,
      });

      expect(transcript.steps).toBe(2);
      expect(transcript.stepsUsed).toBe(5);
    });

    it("shrinks the allowance a resumed pass gets", async () => {
      // Without this, every approval would hand the loop a fresh
      // budget and an approval cycle could run without bound.
      const { workspace } = fakeWorkspace();
      const model = scriptedModel([
        [execCall("c1", { command: READ, backend: "shell" })],
        [say("done")],
      ]);

      const transcript = await runAgentTurn({
        env,
        workspace,
        model,
        prompt: "read it",
        stepsUsed: MAX_STEPS,
      });

      expect(transcript.steps).toBe(1);
      expect(transcript.stepsUsed).toBe(MAX_STEPS + 1);
    });
  });
});
