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

// A run that prints a line, then stays running until `finish()`, as a
// run waiting for an approval does. `waiting` lists what pending()
// reports for it. detachExec() succeeds while the run is going, after
// `detachDelay` if set, as the runtime's does.
function runningWorkspace(
  backends: Array<{
    id: string;
    protocol: "module" | "command";
    callable: boolean;
    detachable: boolean;
  }> = [{ id: "codemode", protocol: "module", callable: true, detachable: true }],
) {
  const state = {
    killed: 0,
    ended: false,
    detached: [] as string[],
    detachDelay: undefined as Promise<void> | undefined,
    waiting: [] as Array<{ id: string; callId: string; payload: unknown }>,
    finish: (_code: number) => {},
  };
  const workspace: ExecWorkspaceLike = {
    runtime: {
      async exec() {
        let finish!: (code: number) => void;
        const finished = new Promise<number>((resolve) => (finish = resolve));
        state.finish = (code) => {
          state.ended = true;
          finish(code);
        };
        return {
          id: "run-1",
          async *[Symbol.asyncIterator]() {
            yield { name: "stdout" as const, value: "asking\n" };
            yield { name: "exit" as const, code: await finished };
          },
          result: async () => ({ exitCode: await finished, stdout: "asking\n", stderr: "" }),
          kill: async () => {
            state.killed += 1;
          },
        };
      },
      pending: async () => state.waiting,
      async detachExec(id) {
        const going = !state.ended;
        await state.detachDelay;
        if (going) state.detached.push(id);
        return going;
      },
      backends: () => backends,
    },
  };
  return { workspace, state };
}

describe("defineExec detach", () => {
  it("returns once the run waits for an answer, and leaves it running", async () => {
    const { workspace, state } = runningWorkspace();
    const exec = defineExec({ workspace, detach: true });
    const output = last(exec.execute({ command: "refund()" }));
    state.waiting = [{ id: "run-1", callId: "run-1:2", payload: { kind: "approval" } }];

    expect(await output).toMatchObject({
      backend: "codemode",
      executionId: "run-1",
      status: "waiting",
      stdout: "asking\n",
      waiting: [{ callId: "run-1:2", payload: { kind: "approval" } }],
    });
    expect(state.detached).toEqual(["run-1"]);
    expect(state.killed).toBe(0);
  });

  it("only counts waits that belong to its own run", async () => {
    const { workspace, state } = runningWorkspace();
    state.waiting = [{ id: "someone-else", callId: "someone-else:1", payload: null }];
    const exec = defineExec({ workspace, detach: true });
    const output = last(exec.execute({ command: "refund()" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    state.finish(0);

    expect(await output).toMatchObject({ exitCode: 0, stdout: "asking\n" });
    expect(state.detached).toEqual([]);
  });

  it("returns once the run has gone on for afterMs", async () => {
    const { workspace, state } = runningWorkspace();
    const exec = defineExec({ workspace, detach: { afterMs: 50 } });

    expect(await last(exec.execute({ command: "research()" }))).toMatchObject({
      executionId: "run-1",
      status: "running",
      stdout: "asking\n",
    });
    expect(state.killed).toBe(0);
  });

  it("returns a run that ends before it detaches as usual", async () => {
    const { workspace, state } = runningWorkspace();
    const exec = defineExec({ workspace, detach: { afterMs: 5_000 } });
    const output = last(exec.execute({ command: "lookup()" }));
    state.finish(0);

    const settled = await output;
    expect(settled).toMatchObject({ exitCode: 0, stdout: "asking\n" });
    expect(settled).not.toHaveProperty("status");
    expect(state.detached).toEqual([]);
  });

  it("replies as detached when the run ends while its detach goes through", async () => {
    const { workspace, state } = runningWorkspace();
    let release!: () => void;
    state.detachDelay = new Promise((resolve) => (release = resolve));
    const exec = defineExec({ workspace, detach: { afterMs: 10 } });
    const output = last(exec.execute({ command: "research()" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The runtime took the detach, so the exit goes to the Workspace:
    // the tool mustn't hand it to the model as well.
    state.finish(0);
    release();

    expect(await output).toMatchObject({ executionId: "run-1", status: "running" });
    expect(state.detached).toEqual(["run-1"]);
  });

  it("stays attached when the run ended before its detach could go through", async () => {
    const { workspace, state } = runningWorkspace();
    const exec = defineExec({ workspace, detach: { afterMs: 10 } });
    const output = last(exec.execute({ command: "research()" }));
    state.ended = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    state.finish(0);

    const settled = await output;
    expect(settled).toMatchObject({ exitCode: 0, stdout: "asking\n" });
    expect(settled).not.toHaveProperty("status");
  });

  it("doesn't kill a detached run when the turn aborts afterwards", async () => {
    const { workspace, state } = runningWorkspace();
    const exec = defineExec({ workspace, detach: { afterMs: 20 } });
    const abort = new AbortController();

    await last(exec.execute({ command: "research()" }, { abortSignal: abort.signal }));
    abort.abort();

    expect(state.killed).toBe(0);
  });

  it("leaves a run on a backend that can't detach attached", async () => {
    const { workspace, state } = runningWorkspace([
      { id: "codemode", protocol: "module", callable: true, detachable: true },
      { id: "sh", protocol: "command", callable: false, detachable: false },
    ]);
    const exec = defineExec({ workspace, detach: { afterMs: 20 } });
    const output = last(exec.execute({ command: "sleep 1", backend: "sh" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    state.finish(0);

    const settled = await output;
    expect(settled).toMatchObject({ backend: "sh", exitCode: 0 });
    expect(settled).not.toHaveProperty("status");
    expect(exec.description).toContain('A run on "codemode" that waits for an answer');
  });

  it("refuses to detach when no backend can", () => {
    const { workspace } = runningWorkspace([
      { id: "codemode", protocol: "module", callable: true, detachable: false },
    ]);
    expect(() => defineExec({ workspace, detach: true })).toThrow(/onDetachedExit/);
  });

  it("refuses to detach without a runtime that can", () => {
    const { workspace } = recordingWorkspace();
    expect(() => defineExec({ workspace, detach: true })).toThrow(/detachExec\(\)/);
  });
});
