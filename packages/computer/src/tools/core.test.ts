import { describe, expect, it } from "vitest";

import { defineExec, type ExecToolOutput } from "./core.js";

describe("defineExec", () => {
  it("builds the exec tool with no agent library", async () => {
    const exec = defineExec({
      workspace: {
        runtime: {
          backends: () => [{ id: "sh", protocol: "command", callable: false }],
          exec: async () => ({
            result: async () => ({ exitCode: 0, stdout: "hi\n", stderr: "" }),
          }),
        },
      },
    });

    expect(exec.description).toContain("Run a shell command");
    expect(exec.inputSchema.safeParse({ command: "echo hi" }).success).toBe(true);
    const snapshots: ExecToolOutput[] = [];
    for await (const snapshot of exec.execute({ command: "echo hi" })) snapshots.push(snapshot);
    expect(snapshots.at(-1)).toEqual({
      command: "echo hi",
      cwd: null,
      backend: "sh",
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
    });
  });
});
