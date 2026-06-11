import { describe, expect, test } from "vitest";
import { handleApiRequest } from "./http";

describe("handleApiRequest", () => {
  test("starts a run from POST /api/runs", async () => {
    const calls: string[] = [];
    const response = await handleApiRequest(
      new Request("https://example.com/api/runs", { method: "POST" }),
      async () => {
        calls.push("start");
        return {
          runId: "run-abc",
          socketPath: "/parties/compare-run/run-abc",
          events: [],
        };
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

  test("returns null for non-API routes", async () => {
    const response = await handleApiRequest(
      new Request("https://example.com/parties/compare-run/run-abc"),
      async () => {
        throw new Error("non-API routes must not start runs");
      },
    );

    expect(response).toBeNull();
  });
});
