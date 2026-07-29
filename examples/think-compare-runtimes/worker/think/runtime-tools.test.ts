import { describe, expect, test } from "vitest";
import { RunEventRecorder } from "../run-events";
import type { RuntimeAdapter } from "../runtime/adapter";
import { createRuntimeThinkTools, executeRuntimeThinkTool } from "./runtime-tools";

function createAdapter(): RuntimeAdapter {
  const files = new Map<string, string>([
    ["/workspace/repo/src/index.ts", "export const value = 1;\n"],
  ]);

  return {
    runtime: "workspace",
    files: {
      async read(path) {
        const content = files.get(path);
        if (content === undefined) throw new Error(`missing ${path}`);
        return content;
      },
      async write(path, contents) {
        files.set(path, contents);
      },
      async edit(path, edits) {
        const content = files.get(path);
        if (content === undefined) throw new Error(`missing ${path}`);
        let updated = content;
        for (const edit of edits) {
          updated = updated.replace(edit.oldText, edit.newText);
        }
        files.set(path, updated);
      },
    },
    async exec(command, options) {
      return {
        exitCode: 0,
        stdout: `${command} ${options?.cwd ?? ""}`.trim(),
        stderr: "",
        executionTarget: "computer-container",
      };
    },
  };
}

describe("createRuntimeThinkTools", () => {
  test("wraps runtime file and exec capabilities as Think tools", async () => {
    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });
    const tools = createRuntimeThinkTools({ adapter: createAdapter(), recorder });

    await expect(
      executeRuntimeThinkTool(tools, "read", { path: "/workspace/repo/src/index.ts" }),
    ).resolves.toEqual({
      path: "/workspace/repo/src/index.ts",
      content: "export const value = 1;\n",
    });
    await expect(
      executeRuntimeThinkTool(tools, "write", {
        path: "/workspace/repo/NOTES.md",
        contents: "status: pending\n",
      }),
    ).resolves.toEqual({ path: "/workspace/repo/NOTES.md", bytesWritten: 16 });
    await expect(
      executeRuntimeThinkTool(tools, "edit", {
        path: "/workspace/repo/NOTES.md",
        edits: [{ oldText: "pending", newText: "done" }],
      }),
    ).resolves.toEqual({ path: "/workspace/repo/NOTES.md", editsApplied: 1 });
    await expect(
      executeRuntimeThinkTool(tools, "exec", { command: "node --version" }),
    ).resolves.toEqual({
      command: "node --version",
      cwd: "/workspace/repo",
      exitCode: 0,
      stdout: "node --version /workspace/repo",
      stderr: "",
      executionTarget: "computer-container",
    });

    expect(recorder.events().map(({ runtime, kind, title }) => ({ runtime, kind, title }))).toEqual(
      [
        { runtime: "workspace", kind: "agent_tool_call", title: "Think requested read" },
        { runtime: "workspace", kind: "agent_tool_result", title: "Think read result" },
        { runtime: "workspace", kind: "agent_tool_call", title: "Think requested write" },
        { runtime: "workspace", kind: "agent_tool_result", title: "Think write result" },
        { runtime: "workspace", kind: "agent_tool_call", title: "Think requested edit" },
        { runtime: "workspace", kind: "agent_tool_result", title: "Think edit result" },
        { runtime: "workspace", kind: "agent_tool_call", title: "Think requested exec" },
        { runtime: "workspace", kind: "agent_tool_result", title: "Think exec result" },
      ],
    );
  });

  test("exposes schemas usable by a real Think model loop", () => {
    const recorder = new RunEventRecorder({ runId: "run-abc" });
    const tools = createRuntimeThinkTools({ adapter: createAdapter(), recorder });

    expect(tools.read.inputSchema.safeParse({ path: "/workspace/repo/src/index.ts" }).success).toBe(
      true,
    );
    expect(tools.write.inputSchema.safeParse({ path: "/workspace/repo/a.txt" }).success).toBe(
      false,
    );
    expect(
      tools.edit.inputSchema.safeParse({
        path: "/workspace/repo/a.txt",
        edits: [{ oldText: "a", newText: "b" }],
      }).success,
    ).toBe(true);
    expect(
      tools.exec.inputSchema.safeParse({ command: "npm test", timeoutMs: 30_000 }).success,
    ).toBe(true);
    expect(tools.read.inputSchema.safeParse({ path: "/tmp/outside.txt" }).success).toBe(false);
    expect(tools.exec.inputSchema.safeParse({ command: "pwd", cwd: "/tmp" }).success).toBe(false);
  });

  test("records Think tool errors", async () => {
    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });
    const tools = createRuntimeThinkTools({ adapter: createAdapter(), recorder });

    await expect(
      executeRuntimeThinkTool(tools, "read", { path: "/workspace/repo/missing.ts" }),
    ).resolves.toEqual({ error: "missing /workspace/repo/missing.ts" });

    expect(
      recorder
        .events()
        .map(({ runtime, kind, title, detail }) => ({ runtime, kind, title, detail })),
    ).toEqual([
      {
        runtime: "workspace",
        kind: "agent_tool_call",
        title: "Think requested read",
        detail: '{"path":"/workspace/repo/missing.ts"}',
      },
      {
        runtime: "workspace",
        kind: "agent_tool_error",
        title: "Think read error",
        detail:
          '{"path":"/workspace/repo/missing.ts","error":"missing /workspace/repo/missing.ts"}',
      },
    ]);
  });

  test("rejects runtime tool paths outside the seeded project", async () => {
    const recorder = new RunEventRecorder({ runId: "run-abc" });
    const tools = createRuntimeThinkTools({ adapter: createAdapter(), recorder });

    await expect(
      executeRuntimeThinkTool(tools, "read", { path: "/tmp/secret.txt" }),
    ).resolves.toEqual({
      error: "Path must be under /workspace/repo.",
    });
    await expect(
      executeRuntimeThinkTool(tools, "exec", { command: "pwd", cwd: "/tmp" }),
    ).resolves.toEqual({
      error: "Path must be under /workspace/repo.",
    });
  });
});
