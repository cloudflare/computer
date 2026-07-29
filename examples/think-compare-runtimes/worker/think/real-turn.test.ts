import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { RunEventRecorder } from "../run-events";
import { createWorkspaceRuntimeAdapter } from "../runtime/adapter";
import { runRealThinkTurn } from "./real-turn";

describe("runRealThinkTurn", () => {
  test("records model-backed Think turn start and completion", async () => {
    const prompts: string[] = [];
    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });
    const adapter = createWorkspaceRuntimeAdapter({
      recorder,
      store: {
        async readFile() {
          return "";
        },
        async writeFile() {},
      },
      runner: {
        async exec() {
          return { exitCode: 0, stdout: "", stderr: "", executionTarget: "computer-container" };
        },
      },
    });

    await expect(
      runRealThinkTurn({
        adapter,
        recorder,
        fixture: comparisonFixture,
        invoke: async ({ prompt }) => {
          prompts.push(prompt);
          return { text: "I updated the runtime-neutral fixture." };
        },
      }),
    ).resolves.toEqual({ text: "I updated the runtime-neutral fixture." });

    expect(prompts[0]).toContain(comparisonFixture.task);
    expect(prompts[0]).toContain("/workspace/repo");
    expect(
      recorder
        .events()
        .map(({ runtime, kind, title, detail }) => ({ runtime, kind, title, detail })),
    ).toEqual([
      {
        runtime: "workspace",
        kind: "agent_message",
        title: "Think turn started",
        detail: "Model-backed Think agent is running against the Workspace runtime.",
      },
      {
        runtime: "workspace",
        kind: "agent_message",
        title: "Think turn complete",
        detail: "I updated the runtime-neutral fixture.",
      },
    ]);
  });

  test("treats empty assistant output as a failed turn", async () => {
    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });
    const adapter = createWorkspaceRuntimeAdapter({
      recorder,
      store: {
        async readFile() {
          return "";
        },
        async writeFile() {},
      },
      runner: {
        async exec() {
          return { exitCode: 0, stdout: "", stderr: "", executionTarget: "computer-container" };
        },
      },
    });

    await expect(
      runRealThinkTurn({
        adapter,
        recorder,
        fixture: comparisonFixture,
        invoke: async () => ({ text: "  " }),
      }),
    ).rejects.toThrow("Think turn completed without assistant text");

    expect(
      recorder
        .events()
        .map(({ runtime, kind, title, detail }) => ({ runtime, kind, title, detail })),
    ).toEqual([
      {
        runtime: "workspace",
        kind: "agent_message",
        title: "Think turn started",
        detail: "Model-backed Think agent is running against the Workspace runtime.",
      },
      {
        runtime: "workspace",
        kind: "agent_tool_error",
        title: "Think turn failed",
        detail: "Think turn completed without assistant text.",
      },
    ]);
  });

  test("records model-backed Think turn failures", async () => {
    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });
    const adapter = createWorkspaceRuntimeAdapter({
      recorder,
      store: {
        async readFile() {
          return "";
        },
        async writeFile() {},
      },
      runner: {
        async exec() {
          return { exitCode: 0, stdout: "", stderr: "", executionTarget: "computer-container" };
        },
      },
    });

    await expect(
      runRealThinkTurn({
        adapter,
        recorder,
        fixture: comparisonFixture,
        invoke: async () => {
          throw new Error("model unavailable");
        },
      }),
    ).rejects.toThrow("model unavailable");

    expect(
      recorder
        .events()
        .map(({ runtime, kind, title, detail }) => ({ runtime, kind, title, detail })),
    ).toEqual([
      {
        runtime: "workspace",
        kind: "agent_message",
        title: "Think turn started",
        detail: "Model-backed Think agent is running against the Workspace runtime.",
      },
      {
        runtime: "workspace",
        kind: "agent_tool_error",
        title: "Think turn failed",
        detail: "model unavailable",
      },
    ]);
  });
});
