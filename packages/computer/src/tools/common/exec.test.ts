import { describe, expect, it } from "vitest";
import { defineExec, type ExecToolOutput, type ExecWorkspaceLike } from "./exec";

// A runtime that records the metadata each run was started with.
function recordingWorkspace(): { workspace: ExecWorkspaceLike; metadata: unknown[] } {
  const metadata: unknown[] = [];
  const workspace: ExecWorkspaceLike = {
    runtime: {
      async exec(_command, options) {
        metadata.push(options.metadata);
        return {
          result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        };
      },
      backends: () => [{ id: "sh", protocol: "command", callable: false }],
    },
  };
  return { workspace, metadata };
}

async function last(output: AsyncIterable<ExecToolOutput>): Promise<ExecToolOutput | undefined> {
  let value: ExecToolOutput | undefined;
  for await (const chunk of output) value = chunk;
  return value;
}

describe("defineExec metadata", () => {
  it("starts each run with the metadata it was given", async () => {
    const { workspace, metadata } = recordingWorkspace();
    const exec = defineExec({ workspace, metadata: { conversation: "c1" } });

    await last(exec.execute({ command: "true" }));

    expect(metadata).toEqual([{ conversation: "c1" }]);
  });

  it("picks each run's metadata from its tool call's id", async () => {
    const { workspace, metadata } = recordingWorkspace();
    const exec = defineExec({
      workspace,
      metadata: ({ toolCallId }) => ({ toolCall: toolCallId }),
    });

    await last(exec.execute({ command: "true" }, { toolCallId: "call-1" }));
    await last(exec.execute({ command: "true" }, { toolCallId: "call-2" }));

    expect(metadata).toEqual([{ toolCall: "call-1" }, { toolCall: "call-2" }]);
  });

  it("uses the metadata a call passes instead", async () => {
    const { workspace, metadata } = recordingWorkspace();
    const exec = defineExec({ workspace, metadata: { conversation: "configured" } });

    await last(exec.execute({ command: "true" }, { metadata: { conversation: "passed" } }));

    expect(metadata).toEqual([{ conversation: "passed" }]);
  });

  it("starts runs without metadata when none is given", async () => {
    const { workspace, metadata } = recordingWorkspace();
    const exec = defineExec({ workspace });

    await last(exec.execute({ command: "true" }));

    expect(metadata).toEqual([undefined]);
  });

  it("reports a failure to pick metadata as the call's error, without running", async () => {
    const { workspace, metadata } = recordingWorkspace();
    const exec = defineExec({
      workspace,
      metadata: () => {
        throw new Error("no conversation");
      },
    });

    await expect(last(exec.execute({ command: "true" }))).resolves.toEqual({
      command: "true",
      cwd: null,
      backend: "sh",
      error: "no conversation",
    });
    expect(metadata).toEqual([]);
  });
});
