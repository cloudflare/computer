import { describe, expect, test } from "vitest";
import { RunEventRecorder } from "../run-events";
import { createRuntimeFileTools } from "./file-tools";

describe("createRuntimeFileTools", () => {
  test("reads, writes, and edits files with runtime tool events", async () => {
    const files = new Map<string, string>([
      ["/workspace/repo/src/index.ts", "export const value = 1;\n"],
    ]);
    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });
    const tools = createRuntimeFileTools({
      runtime: "workspace",
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
    });

    await expect(tools.read("/workspace/repo/src/index.ts")).resolves.toBe(
      "export const value = 1;\n",
    );
    await tools.write("/workspace/repo/README.md", "hello\n");
    await tools.edit("/workspace/repo/src/index.ts", [
      { oldText: "value = 1", newText: "value = 2" },
    ]);

    expect(files.get("/workspace/repo/README.md")).toBe("hello\n");
    expect(files.get("/workspace/repo/src/index.ts")).toBe("export const value = 2;\n");
    expect(recorder.events().map(({ runtime, kind, title }) => ({ runtime, kind, title }))).toEqual(
      [
        { runtime: "workspace", kind: "tool_call", title: "read /workspace/repo/src/index.ts" },
        { runtime: "workspace", kind: "tool_result", title: "read complete" },
        { runtime: "workspace", kind: "tool_call", title: "write /workspace/repo/README.md" },
        { runtime: "workspace", kind: "tool_result", title: "write complete" },
        { runtime: "workspace", kind: "tool_call", title: "edit /workspace/repo/src/index.ts" },
        { runtime: "workspace", kind: "tool_result", title: "edit complete" },
      ],
    );
  });

  test("records tool errors for non-unique edit replacements", async () => {
    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });
    const tools = createRuntimeFileTools({
      runtime: "sandbox",
      recorder,
      store: {
        async readFile() {
          return "repeat repeat";
        },
        async writeFile() {
          throw new Error("write should not run");
        },
      },
    });

    await expect(
      tools.edit("/workspace/repo/src/index.ts", [{ oldText: "repeat", newText: "once" }]),
    ).rejects.toThrow("must match exactly once");
    expect(recorder.events().map(({ runtime, kind, title }) => ({ runtime, kind, title }))).toEqual(
      [
        { runtime: "sandbox", kind: "tool_call", title: "edit /workspace/repo/src/index.ts" },
        { runtime: "sandbox", kind: "tool_error", title: "edit failed" },
      ],
    );
  });
});
