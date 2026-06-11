import { describe, expect, test } from "vitest";
import { RunEventRecorder } from "../run-events";
import { createInstrumentedFixtureRuntime } from "./instrumented";

describe("createInstrumentedFixtureRuntime", () => {
  test("records tool call and result events around runtime file operations", async () => {
    const operations: string[] = [];
    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });
    const runtime = createInstrumentedFixtureRuntime({
      runtime: "workspace",
      inner: {
        async mkdir(path) {
          operations.push(`mkdir ${path}`);
        },
        async writeFile(path, contents) {
          operations.push(`write ${path} ${contents}`);
        },
      },
      recorder,
    });

    await runtime.mkdir("/workspace/repo");
    await runtime.writeFile("/workspace/repo/package.json", "{}\n");

    expect(operations).toEqual([
      "mkdir /workspace/repo",
      "write /workspace/repo/package.json {}\n",
    ]);
    expect(
      recorder.events().map(({ sequence, runtime, kind, title, detail }) => ({
        sequence,
        runtime,
        kind,
        title,
        detail,
      })),
    ).toEqual([
      {
        sequence: 0,
        runtime: "workspace",
        kind: "tool_call",
        title: "mkdir /workspace/repo",
        detail: "Creating directory through workspace runtime.",
      },
      {
        sequence: 1,
        runtime: "workspace",
        kind: "tool_result",
        title: "mkdir complete",
        detail: "Created /workspace/repo.",
      },
      {
        sequence: 2,
        runtime: "workspace",
        kind: "tool_call",
        title: "write /workspace/repo/package.json",
        detail: "Writing 3 bytes through workspace runtime.",
      },
      {
        sequence: 3,
        runtime: "workspace",
        kind: "tool_result",
        title: "write complete",
        detail: "Wrote /workspace/repo/package.json.",
      },
    ]);
  });
});
