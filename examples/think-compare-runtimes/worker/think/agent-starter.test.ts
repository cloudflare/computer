import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { startRuntimeThinkAgents } from "./agent-starter";

describe("startRuntimeThinkAgents", () => {
  test("starts Workspace without waiting for the Sandbox handle", async () => {
    const lifecycle: string[] = [];
    const sandboxHandle = deferred<{
      runComparison(): Promise<void>;
    }>();

    const run = startRuntimeThinkAgents({
      runId: "run-abc",
      fixture: comparisonFixture,
      workspaceAgent: {
        async runComparison() {
          lifecycle.push("workspace run");
        },
      },
      sandboxAgent: sandboxHandle.promise,
      onAgentStart(runtime) {
        lifecycle.push(`${runtime} started`);
      },
      onAgentComplete(runtime) {
        lifecycle.push(`${runtime} completed`);
      },
    });

    await flushPromises();
    expect(lifecycle).toEqual(["workspace started", "workspace run", "workspace completed"]);

    sandboxHandle.resolve({
      async runComparison() {
        lifecycle.push("sandbox run");
      },
    });
    await run;

    expect(lifecycle).toEqual([
      "workspace started",
      "workspace run",
      "workspace completed",
      "sandbox started",
      "sandbox run",
      "sandbox completed",
    ]);
  });

  test("starts Workspace and Sandbox Think agents concurrently", async () => {
    const calls: string[] = [];

    await startRuntimeThinkAgents({
      runId: "run-abc",
      fixture: comparisonFixture,
      workspaceAgent: {
        async runComparison(input) {
          calls.push(`workspace ${input.runId} ${input.fixture.root}`);
        },
      },
      sandboxAgent: {
        async runComparison(input) {
          calls.push(`sandbox ${input.runId} ${input.fixture.root}`);
        },
      },
    });

    expect(calls.sort()).toEqual([
      "sandbox run-abc /workspace/repo",
      "workspace run-abc /workspace/repo",
    ]);
  });

  test("records agent startup failures without cancelling the other agent", async () => {
    const calls: string[] = [];
    const failures: string[] = [];

    await startRuntimeThinkAgents({
      runId: "run-abc",
      fixture: comparisonFixture,
      workspaceAgent: {
        async runComparison() {
          calls.push("workspace start");
          throw new Error("workspace failed");
        },
      },
      sandboxAgent: {
        async runComparison() {
          calls.push("sandbox complete");
        },
      },
      onAgentError(runtime, error) {
        failures.push(`${runtime} ${error instanceof Error ? error.message : String(error)}`);
      },
    });

    expect(calls.sort()).toEqual(["sandbox complete", "workspace start"]);
    expect(failures).toEqual(["workspace workspace failed"]);
  });

  test("emits each runtime terminal callback as soon as that runtime settles", async () => {
    const lifecycle: string[] = [];
    const workspace = deferred<void>();
    const sandbox = deferred<void>();

    const run = startRuntimeThinkAgents({
      runId: "run-abc",
      fixture: comparisonFixture,
      workspaceAgent: {
        async runComparison() {
          lifecycle.push("workspace run");
          await workspace.promise;
        },
      },
      sandboxAgent: {
        async runComparison() {
          lifecycle.push("sandbox run");
          await sandbox.promise;
        },
      },
      onAgentStart(runtime) {
        lifecycle.push(`${runtime} started`);
      },
      onAgentComplete(runtime) {
        lifecycle.push(`${runtime} completed`);
      },
      onAgentError(runtime, error) {
        lifecycle.push(
          `${runtime} failed ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });

    await flushPromises();
    expect(lifecycle).toEqual([
      "workspace started",
      "sandbox started",
      "workspace run",
      "sandbox run",
    ]);

    workspace.resolve();
    await flushPromises();
    expect(lifecycle).toEqual([
      "workspace started",
      "sandbox started",
      "workspace run",
      "sandbox run",
      "workspace completed",
    ]);

    sandbox.resolve();
    await run;
    expect(lifecycle).toEqual([
      "workspace started",
      "sandbox started",
      "workspace run",
      "sandbox run",
      "workspace completed",
      "sandbox completed",
    ]);
  });

  test("emits lifecycle callbacks for runtime terminal status", async () => {
    const lifecycle: string[] = [];

    await startRuntimeThinkAgents({
      runId: "run-abc",
      fixture: comparisonFixture,
      workspaceAgent: {
        async runComparison() {
          lifecycle.push("workspace run");
        },
      },
      sandboxAgent: {
        async runComparison() {
          lifecycle.push("sandbox run");
          throw new Error("capacity exceeded");
        },
      },
      onAgentStart(runtime) {
        lifecycle.push(`${runtime} started`);
      },
      onAgentComplete(runtime) {
        lifecycle.push(`${runtime} completed`);
      },
      onAgentError(runtime, error) {
        lifecycle.push(
          `${runtime} failed ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });

    expect(lifecycle).toEqual([
      "workspace started",
      "sandbox started",
      "workspace run",
      "sandbox run",
      "workspace completed",
      "sandbox failed capacity exceeded",
    ]);
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
