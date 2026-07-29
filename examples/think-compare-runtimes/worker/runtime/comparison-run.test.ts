import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import { runFixtureComparison } from "./comparison-run";

describe("runFixtureComparison", () => {
  test("records one ordered event stream for both runtime fixture setups", async () => {
    const workspaceFiles = new Map<string, string>();
    const sandboxFiles = new Map<string, string>();
    const workspaceWrites: string[] = [];
    const sandboxWrites: string[] = [];

    const events = await runFixtureComparison({
      runId: "run-abc",
      fixture: comparisonFixture,
      now: () => "2026-06-04T00:00:00.000Z",
      workspaceRuntime: {
        async mkdir() {},
        async writeFile(path, contents) {
          workspaceWrites.push(path);
          workspaceFiles.set(path, contents);
        },
      },
      sandboxRuntime: {
        async mkdir() {},
        async writeFile(path, contents) {
          sandboxWrites.push(path);
          sandboxFiles.set(path, contents);
        },
      },
      workspaceAdapterStore: {
        async readFile(path) {
          return workspaceFiles.get(path) ?? "";
        },
        async writeFile(path, contents) {
          workspaceFiles.set(path, contents);
        },
      },
      sandboxAdapterStore: {
        async readFile(path) {
          return sandboxFiles.get(path) ?? "";
        },
        async writeFile(path, contents) {
          sandboxFiles.set(path, contents);
        },
      },
      workspaceCommandRunner: {
        async exec(command, options) {
          expect(options?.cwd).toBeUndefined();
          return {
            exitCode: 0,
            stdout: `workspace ${command}\n`,
            stderr: "",
            executionTarget: "computer-container",
          };
        },
      },
      sandboxCommandRunner: {
        async exec(command, options) {
          expect(options?.cwd).toBeUndefined();
          return {
            exitCode: 0,
            stdout: `sandbox ${command}\n`,
            stderr: "",
            executionTarget: "sandbox-container",
          };
        },
      },
    });

    expect(workspaceWrites).toEqual(expectedFixturePaths());
    expect(sandboxWrites).toEqual(workspaceWrites);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_, sequence) => sequence),
    );
    const fixtureSetupEventCount = 1 + 2 * perRuntimeFixtureSetupEventCount();
    const scriptedTurnEventCount = 2 * (2 + 4 * 4);
    expect(events).toHaveLength(fixtureSetupEventCount + scriptedTurnEventCount);
    expect(events[0]).toMatchObject({
      runtime: "both",
      kind: "run_started",
      title: "Comparison run started",
    });
    expect(events.map((event) => event.title)).toEqual(
      expect.arrayContaining([
        "Workspace fixture seeded",
        "Sandbox fixture seeded",
        "read /workspace/repo/feature-briefs/smart-request-policies.md",
        "read complete",
        "Scripted Think turn started",
        "Think requested read",
        "Think requested write",
        "Think requested edit",
        "Think requested exec",
        "Scripted Think turn complete",
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtime: "workspace",
          kind: "agent_message",
          title: "Scripted Think turn started",
        }),
        expect.objectContaining({
          runtime: "sandbox",
          kind: "agent_message",
          title: "Scripted Think turn complete",
        }),
      ]),
    );
  });
});

function expectedFixturePaths(): string[] {
  return comparisonFixture.files.map((file) => `${comparisonFixture.root}/${file.path}`);
}

function perRuntimeFixtureSetupEventCount(): number {
  const rootMkdirEvents = 2;
  const seededEvent = 1;
  const files = comparisonFixture.files.map((file) => `${comparisonFixture.root}/${file.path}`);
  const parentDirs = new Set(
    files
      .map((path) => path.slice(0, path.lastIndexOf("/")))
      .filter((directory) => directory !== comparisonFixture.root),
  );

  return rootMkdirEvents + parentDirs.size * 2 + files.length * 2 + seededEvent;
}
