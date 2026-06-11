import { describe, expect, test } from "vitest";
import { handleApiRequest } from "./http";

describe("handleApiRequest", () => {
  test("starts a run from POST /api/runs", async () => {
    const calls: string[] = [];
    const response = await handleApiRequest(
      new Request("https://example.com/api/runs", { method: "POST" }),
      {
        async startRun() {
          calls.push("start");
          return {
            runId: "run-abc",
            socketPath: "/parties/compare-run/run-abc",
            events: [],
          };
        },
        async stopRun() {
          throw new Error("start route must not stop runs");
        },
      },
    );

    expect(calls).toEqual(["start"]);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      runId: "run-abc",
      socketPath: "/parties/compare-run/run-abc",
    });
  });

  test("stops a run from POST /api/runs/:runId/stop", async () => {
    const calls: string[] = [];
    const response = await handleApiRequest(
      new Request("https://example.com/api/runs/run-abc/stop", { method: "POST" }),
      {
        async startRun() {
          throw new Error("stop route must not start runs");
        },
        async stopRun(runId) {
          calls.push(runId);
        },
      },
    );

    expect(calls).toEqual(["run-abc"]);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(204);
  });

  test("returns null for non-API routes", async () => {
    const response = await handleApiRequest(
      new Request("https://example.com/parties/compare-run/run-abc"),
      {
        async startRun() {
          throw new Error("non-API routes must not start runs");
        },
        async stopRun() {
          throw new Error("non-API routes must not stop runs");
        },
      },
    );

    expect(response).toBeNull();
  });
});
