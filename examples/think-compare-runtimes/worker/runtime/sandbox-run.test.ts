import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { RunEventRecorder } from "../run-events";
import { runSandboxFixtureSetup } from "./sandbox-run";

describe("runSandboxFixtureSetup", () => {
  test("seeds the fixture and returns Sandbox timeline events", async () => {
    const writes: string[] = [];

    const recorder = new RunEventRecorder({
      runId: "run-abc",
      now: () => "2026-06-04T00:00:00.000Z",
    });

    const events = await runSandboxFixtureSetup({
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
  runtime: "sandbox";
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
    { runtime: "sandbox" as const, kind: "tool_call" as const, title: "mkdir /workspace/repo" },
    { runtime: "sandbox" as const, kind: "tool_result" as const, title: "mkdir complete" },
    ...parentDirs.map((directory) => ({
      runtime: "sandbox" as const,
      kind: "tool_call" as const,
      title: `mkdir ${directory}`,
    })),
    ...parentDirs.map(() => ({
      runtime: "sandbox" as const,
      kind: "tool_result" as const,
      title: "mkdir complete",
    })),
    ...files.map((path) => ({
      runtime: "sandbox" as const,
      kind: "tool_call" as const,
      title: `write ${path}`,
    })),
    ...files.map(() => ({
      runtime: "sandbox" as const,
      kind: "tool_result" as const,
      title: "write complete",
    })),
    {
      runtime: "sandbox" as const,
      kind: "runtime_note" as const,
      title: "Sandbox fixture seeded",
    },
  ];
  return summaries.map((summary, sequence) => ({ sequence, ...summary }));
}
