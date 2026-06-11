import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../shared/fixture";
import { runComparisonAgents } from "./comparison-agents";
import type { RunEventInput } from "./run-events";

describe("runComparisonAgents", () => {
  test("records runtime and run terminal events", async () => {
    const events: RunEventInput[] = [];

    await runComparisonAgents({
      runId: "run-abc",
      fixture: comparisonFixture,
      workspaceAgent: {
        async runComparison() {},
      },
      sandboxAgent: {
        async runComparison() {
          throw new Error("capacity exceeded");
        },
      },
      appendEvent(input) {
        events.push(input);
      },
    });

    expect(events).toEqual([
      {
        runtime: "workspace",
        kind: "runtime_started",
        title: "Workspace runtime started",
        detail: "Workspace Think agent is running.",
      },
      {
        runtime: "sandbox",
        kind: "runtime_started",
        title: "Sandbox runtime started",
        detail: "Sandbox Think agent is running.",
      },
      {
        runtime: "workspace",
        kind: "runtime_completed",
        title: "Workspace runtime completed",
        detail: "Workspace Think agent completed.",
      },
      {
        runtime: "sandbox",
        kind: "runtime_failed",
        title: "Sandbox runtime failed",
        detail: "capacity exceeded",
      },
      {
        runtime: "both",
        kind: "run_completed",
        title: "Comparison run complete",
        detail: "Workspace completed; Sandbox failed.",
      },
    ]);
  });
});
