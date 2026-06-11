import type { RunEvent } from "../../shared/events";
import type { ComparisonFixture } from "../../shared/fixture";
import { RunEventRecorder } from "../run-events";
import { createInstrumentedFixtureRuntime } from "./instrumented";
import { type FixtureRuntime, seedFixture } from "./seed";

export interface WorkspaceFixtureSetupOptions {
  runId: string;
  fixture: ComparisonFixture;
  runtime: FixtureRuntime;
  recorder?: RunEventRecorder;
  now?: () => string;
}

export async function runWorkspaceFixtureSetup({
  runId,
  fixture,
  runtime,
  recorder,
  now = () => new Date().toISOString(),
}: WorkspaceFixtureSetupOptions): Promise<RunEvent[]> {
  const eventRecorder = recorder ?? new RunEventRecorder({ runId, now });
  const startIndex = eventRecorder.events().length;

  await seedFixture(
    createInstrumentedFixtureRuntime({
      runtime: "workspace",
      inner: runtime,
      recorder: eventRecorder,
    }),
    fixture,
  );
  eventRecorder.record({
    runtime: "workspace",
    kind: "runtime_note",
    title: "Workspace fixture seeded",
    detail: `Wrote ${fixture.files.length} files through Workspace.fs at ${fixture.root} before starting a shell container.`,
  });

  return eventRecorder.events().slice(startIndex);
}
