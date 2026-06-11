import { describe, expect, test } from "vitest";
import type { RunEvent } from "../shared/events";
import { startComparisonRun } from "./start-run";

const event: RunEvent = {
  id: "run-abc:0",
  runId: "run-abc",
  sequence: 0,
  runtime: "workspace",
  kind: "runtime_note",
  title: "Workspace seeded",
  detail: "Fixture files were written through Workspace.fs.",
  timestamp: "1970-01-01T00:00:00.000Z",
};

describe("startComparisonRun", () => {
  test("creates a run and starts its CompareRun durable object", async () => {
    const started: string[] = [];

    const session = await startComparisonRun({
      createId: () => "run-abc",
      getRun(runId) {
        return {
          async startComparison() {
            started.push(runId);
            return [event];
          },
        };
      },
    });

    expect(started).toEqual(["run-abc"]);
    expect(session).toEqual({
      runId: "run-abc",
      socketPath: "/parties/compare-run/run-abc",
      events: [event],
    });
  });
});
