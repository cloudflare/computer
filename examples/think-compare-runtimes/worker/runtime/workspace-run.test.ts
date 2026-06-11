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
  const files = comparisonFixture.files.map((file) => `${comparisonFixture.root}/${file.path}`);
  const parentDirs = [
    ...new Set(
      files
        .map((path) => path.slice(0, path.lastIndexOf("/")))
        .filter((directory) => directory !== comparisonFixture.root),
    ),
  ];
  const summaries = [
    { runtime: "workspace" as const, kind: "tool_call" as const, title: "mkdir /workspace/repo" },
    { runtime: "workspace" as const, kind: "tool_result" as const, title: "mkdir complete" },
    ...parentDirs.map((directory) => ({
      runtime: "workspace" as const,
      kind: "tool_call" as const,
      title: `mkdir ${directory}`,
    })),
    ...parentDirs.map(() => ({
      runtime: "workspace" as const,
      kind: "tool_result" as const,
      title: "mkdir complete",
    })),
    ...files.map((path) => ({
      runtime: "workspace" as const,
      kind: "tool_call" as const,
      title: `write ${path}`,
    })),
    ...files.map(() => ({
      runtime: "workspace" as const,
      kind: "tool_result" as const,
      title: "write complete",
    })),
    {
      runtime: "workspace" as const,
      kind: "runtime_note" as const,
      title: "Workspace fixture seeded",
    },
  ];
  return summaries.map((summary, sequence) => ({ sequence, ...summary }));
}
