import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { RunEventRecorder } from "../run-events";
import { runWorkspaceFixtureSetup } from "./workspace-run";

describe("runWorkspaceFixtureSetup", () => {
  test("seeds the fixture and returns Workspace timeline events", async () => {
    const writes: string[] = [];

    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });

    const events = await runWorkspaceFixtureSetup({
      runId: "run-abc",
      fixture: comparisonFixture,
      recorder,
      runtime: {
        async mkdir() {},
        async writeFile(path) {
          writes.push(path);
        },
      },
    });

    expect(writes).toEqual(expectedFixturePaths());
    expect(
      events.map(({ sequence, runtime, kind, title }) => ({
        sequence,
        runtime,
        kind,
        title,
      })),
    ).toEqual(expectedFixtureEventSummaries());
  });
});

function expectedFixturePaths(): string[] {
  return comparisonFixture.files.map((file) => `${comparisonFixture.root}/${file.path}`);
}

function expectedFixtureEventSummaries(): Array<{
  sequence: number;
  runtime: "workspace";
  kind: "tool_call" | "tool_result" | "runtime_note";
  title: string;
}> {
  const summaries = [
    { runtime: "workspace" as const, kind: "tool_call" as const, title: "mkdir /workspace/repo" },
    { runtime: "workspace" as const, kind: "tool_result" as const, title: "mkdir complete" },
    ...comparisonFixture.files.flatMap((file) => {
      const path = `${comparisonFixture.root}/${file.path}`;
      const directory = path.slice(0, path.lastIndexOf("/"));
      const events: Array<{
        runtime: "workspace";
        kind: "tool_call" | "tool_result";
        title: string;
      }> = [];
      if (directory !== comparisonFixture.root) {
        events.push(
          { runtime: "workspace", kind: "tool_call", title: `mkdir ${directory}` },
          { runtime: "workspace", kind: "tool_result", title: "mkdir complete" },
        );
      }
      events.push(
        { runtime: "workspace", kind: "tool_call", title: `write ${path}` },
        { runtime: "workspace", kind: "tool_result", title: "write complete" },
      );
      return events;
    }),
    {
      runtime: "workspace" as const,
      kind: "runtime_note" as const,
      title: "Workspace fixture seeded",
    },
  ];
  return summaries.map((summary, sequence) => ({ sequence, ...summary }));
}
