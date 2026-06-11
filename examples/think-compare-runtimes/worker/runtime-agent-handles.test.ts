import { describe, expect, test, vi } from "vitest";

vi.mock("agents", () => ({
  getAgentByName: vi.fn(),
}));

import { getRuntimeAgentHandles } from "./runtime-agent-handles";

describe("getRuntimeAgentHandles", () => {
  test("requests Workspace and Sandbox agent handles concurrently", async () => {
    const calls: string[] = [];
    const workspace = deferred<unknown>();
    const sandbox = deferred<unknown>();

    const handles = getRuntimeAgentHandles({
      runId: "run-abc",
      workspaceNamespace: {} as DurableObjectNamespace,
      sandboxNamespace: {} as DurableObjectNamespace,
      getAgent(_namespace, name) {
        calls.push(`start ${name}`);
        if (name.endsWith("-workspace")) return workspace.promise;
        if (name.endsWith("-sandbox")) return sandbox.promise;
        throw new Error(`unexpected agent ${name}`);
      },
    });

    await flushPromises();
    expect(calls).toEqual(["start run-abc-workspace", "start run-abc-sandbox"]);

    workspace.resolve({ runComparison: async () => {} });
    sandbox.resolve({ runComparison: async () => {} });
    await expect(handles.workspaceAgent).resolves.toEqual({ runComparison: expect.any(Function) });
    await expect(handles.sandboxAgent).resolves.toEqual({ runComparison: expect.any(Function) });
  });
});

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
