import { describe, expect, test } from "vitest";
import { RunEventRecorder } from "../run-events";
import { createSandboxRuntimeAdapter, createWorkspaceRuntimeAdapter } from "./adapter";

describe("runtime adapters", () => {
  test("createWorkspaceRuntimeAdapter exposes runtime-neutral file tools", async () => {
    const files = new Map<string, string>([["/workspace/repo/src/index.ts", "workspace file"]]);
    const recorder = new RunEventRecorder({ runId: "run-abc" });
    const adapter = createWorkspaceRuntimeAdapter({
      recorder,
      workspace: {
        async ready() {},
        fs: {
          async readFile(path: string, encoding: "utf8") {
            expect(encoding).toBe("utf8");
            return files.get(path) ?? "";
          },
          async writeFile(path: string, contents: string) {
            files.set(path, contents);
          },
        },
        runtime: {
          async exec(command: string) {
            return {
              async result() {
                return { exitCode: 0, stdout: `${command}\n`, stderr: "", pushed: 0, pulled: 0 };
              },
            };
          },
        },
      },
    });

    expect(adapter.runtime).toBe("workspace");
    await expect(adapter.files.read("/workspace/repo/src/index.ts")).resolves.toBe(
      "workspace file",
    );
    await adapter.files.write("/workspace/repo/src/created.ts", "created");
    await expect(adapter.exec("node --version")).resolves.toEqual({
      exitCode: 0,
      stdout: "node --version\n",
      stderr: "",
      executionTarget: "computer-container",
    });
    expect(files.get("/workspace/repo/src/created.ts")).toBe("created");
    expect(recorder.events().map((event) => event.runtime)).toEqual([
      "workspace",
      "workspace",
      "workspace",
      "workspace",
      "workspace",
      "workspace",
    ]);
  });

  test("createSandboxRuntimeAdapter exposes runtime-neutral file tools", async () => {
    const files = new Map<string, string>([["/workspace/repo/src/index.ts", "sandbox file"]]);
    const recorder = new RunEventRecorder({ runId: "run-abc" });
    const adapter = createSandboxRuntimeAdapter({
      recorder,
      sandbox: {
        async readFile(path: string) {
          return { content: files.get(path) ?? "" };
        },
        async writeFile(path: string, contents: string) {
          files.set(path, contents);
        },
        async exec(command: string) {
          return {
            success: true,
            exitCode: 0,
            stdout: `${command}\n`,
            stderr: "",
            command,
            duration: 1,
            timestamp: "2026-06-04T00:00:00.000Z",
          };
        },
      },
    });

    expect(adapter.runtime).toBe("sandbox");
    await expect(adapter.files.read("/workspace/repo/src/index.ts")).resolves.toBe("sandbox file");
    await adapter.files.write("/workspace/repo/src/created.ts", "created");
    await expect(adapter.exec("node --version")).resolves.toEqual({
      exitCode: 0,
      stdout: "node --version\n",
      stderr: "",
      executionTarget: "sandbox-container",
    });
    expect(files.get("/workspace/repo/src/created.ts")).toBe("created");
    expect(recorder.events().map((event) => event.runtime)).toEqual([
      "sandbox",
      "sandbox",
      "sandbox",
      "sandbox",
      "sandbox",
      "sandbox",
    ]);
  });
});
