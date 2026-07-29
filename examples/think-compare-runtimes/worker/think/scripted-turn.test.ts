import { describe, expect, test } from "vitest";
import { RunEventRecorder } from "../run-events";
import { createWorkspaceRuntimeAdapter } from "../runtime/adapter";
import { runScriptedThinkToolSmoke } from "./scripted-turn";

describe("runScriptedThinkToolSmoke", () => {
  test("drives the Think-facing tools through a deterministic transcript", async () => {
    const files = new Map<string, string>([
      ["/workspace/repo/feature-briefs/smart-request-policies.md", "# Smart Request Policies\n"],
    ]);
    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });
    const adapter = createWorkspaceRuntimeAdapter({
      recorder,
      store: {
        async readFile(path) {
          const contents = files.get(path);
          if (contents === undefined) throw new Error(`missing ${path}`);
          return contents;
        },
        async writeFile(path, contents) {
          files.set(path, contents);
        },
      },
      runner: {
        async exec(command) {
          return {
            exitCode: 0,
            stdout: `${command}\n`,
            stderr: "",
            executionTarget: "computer-container",
          };
        },
      },
    });

    await runScriptedThinkToolSmoke({ adapter, recorder, root: "/workspace/repo" });

    expect(files.get("/workspace/repo/THINK_NOTES.md")).toBe("Think tool smoke: done\n");
    expect(recorder.events().map(({ runtime, kind, title }) => ({ runtime, kind, title }))).toEqual(
      [
        { runtime: "workspace", kind: "agent_message", title: "Scripted Think turn started" },
        { runtime: "workspace", kind: "agent_tool_call", title: "Think requested read" },
        {
          runtime: "workspace",
          kind: "tool_call",
          title: "read /workspace/repo/feature-briefs/smart-request-policies.md",
        },
        { runtime: "workspace", kind: "tool_result", title: "read complete" },
        { runtime: "workspace", kind: "agent_tool_result", title: "Think read result" },
        { runtime: "workspace", kind: "agent_tool_call", title: "Think requested write" },
        { runtime: "workspace", kind: "tool_call", title: "write /workspace/repo/THINK_NOTES.md" },
        { runtime: "workspace", kind: "tool_result", title: "write complete" },
        { runtime: "workspace", kind: "agent_tool_result", title: "Think write result" },
        { runtime: "workspace", kind: "agent_tool_call", title: "Think requested edit" },
        { runtime: "workspace", kind: "tool_call", title: "edit /workspace/repo/THINK_NOTES.md" },
        { runtime: "workspace", kind: "tool_result", title: "edit complete" },
        { runtime: "workspace", kind: "agent_tool_result", title: "Think edit result" },
        { runtime: "workspace", kind: "agent_tool_call", title: "Think requested exec" },
        { runtime: "workspace", kind: "tool_call", title: "exec node --version" },
        { runtime: "workspace", kind: "tool_result", title: "exec complete" },
        { runtime: "workspace", kind: "agent_tool_result", title: "Think exec result" },
        { runtime: "workspace", kind: "agent_message", title: "Scripted Think turn complete" },
      ],
    );
  });
});
