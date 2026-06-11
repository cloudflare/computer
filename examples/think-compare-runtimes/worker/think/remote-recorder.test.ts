import { describe, expect, test } from "vitest";
import type { RunEventInput } from "../run-events";
import { createRemoteRunEventRecorder } from "./remote-recorder";

describe("createRemoteRunEventRecorder", () => {
  test("forwards agent events to CompareRun", async () => {
    const inputs: RunEventInput[] = [];
    const recorder = createRemoteRunEventRecorder({
      async appendEvent(input) {
        inputs.push(input);
        return {
          ...input,
          id: "run-abc:0",
          runId: "run-abc",
          sequence: 0,
          timestamp: "2026-06-04T00:00:00.000Z",
        };
      },
    });

    await recorder.record({
      runtime: "sandbox",
      kind: "agent_message",
      title: "Think turn started",
      detail: "Running.",
    });

    expect(inputs).toEqual([
      {
        runtime: "sandbox",
        kind: "agent_message",
        title: "Think turn started",
        detail: "Running.",
      },
    ]);
  });
});
