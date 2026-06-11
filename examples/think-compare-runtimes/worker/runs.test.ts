import { describe, expect, test } from "vitest";
import { createRunSession } from "./runs";

describe("createRunSession", () => {
  test("creates a run payload with a PartyServer socket path", () => {
    const run = createRunSession(() => "abc123");

    expect(run).toMatchObject({
      runId: "abc123",
      socketPath: "/parties/compare-run/abc123",
    });
    expect(run.events).toEqual([]);
  });

  test("creates a run ID from the runtime crypto object", () => {
    const run = createRunSession();

    expect(run.runId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
