import { describe, expect, test } from "vitest";
import { RunEventRecorder } from "../run-events";
import { createRuntimeExecTool } from "./exec-tools";

describe("createRuntimeExecTool", () => {
  test("runs commands with runtime tool events", async () => {
    const calls: Array<{ command: string; cwd?: string; timeoutMs?: number }> = [];
    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });
    const exec = createRuntimeExecTool({
      runtime: "workspace",
      recorder,
      runner: {
        async exec(command, options) {
          calls.push({ command, cwd: options?.cwd, timeoutMs: options?.timeoutMs });
          return {
            exitCode: 0,
            stdout: "ok\n",
            stderr: "",
            executionTarget: "workspace-container",
          };
        },
      },
    });

    await expect(
      exec("npm test -- --runInBand", { cwd: "/workspace/repo", timeoutMs: 30_000 }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      executionTarget: "workspace-container",
    });

    expect(calls).toEqual([
      { command: "npm test -- --runInBand", cwd: "/workspace/repo", timeoutMs: 30_000 },
    ]);
    expect(
      recorder
        .events()
        .map(({ runtime, kind, title, detail }) => ({ runtime, kind, title, detail })),
    ).toEqual([
      {
        runtime: "workspace",
        kind: "tool_call",
        title: "exec npm test -- --runInBand",
        detail: "Running command in /workspace/repo through workspace runtime.",
      },
      {
        runtime: "workspace",
        kind: "tool_result",
        title: "exec complete",
        detail: "Exit 0; stdout 3 bytes; stderr 0 bytes.",
      },
    ]);
  });

  test("records tool errors when command startup fails", async () => {
    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });
    const exec = createRuntimeExecTool({
      runtime: "sandbox",
      recorder,
      runner: {
        async exec() {
          throw new Error("container unavailable");
        },
      },
    });

    await expect(exec("node --version")).rejects.toThrow("container unavailable");
    expect(
      recorder
        .events()
        .map(({ runtime, kind, title, detail }) => ({ runtime, kind, title, detail })),
    ).toEqual([
      {
        runtime: "sandbox",
        kind: "tool_call",
        title: "exec node --version",
        detail: "Running command through sandbox runtime.",
      },
      {
        runtime: "sandbox",
        kind: "tool_error",
        title: "exec failed",
        detail: "container unavailable",
      },
    ]);
  });
});
