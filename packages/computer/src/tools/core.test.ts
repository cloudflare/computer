import { describe, expect, it } from "vitest";

import { defineExec, type ExecToolOutput } from "./core.js";

describe("defineExec", () => {
  it("parses an input object sent as text only for a callable backend", () => {
    const define = (callable: boolean) =>
      defineExec({
        workspace: {
          runtime: {
            backends: () => [{ id: "b", protocol: "module", callable }],
            exec: async () => {
              throw new Error("not run");
            },
          },
        },
      });
    const args = { command: "x", input: '{"a":1}' };

    expect(define(true).prepareArguments(args)).toEqual({ command: "x", input: { a: 1 } });
    expect(args.input).toBe('{"a":1}');
    expect(define(false).prepareArguments(args)).toBe(args);
    expect(define(true).prepareArguments({ command: "x", input: "null" })).toEqual({
      command: "x",
      input: "null",
    });
    expect(define(true).prepareArguments("text")).toBe("text");
  });

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
