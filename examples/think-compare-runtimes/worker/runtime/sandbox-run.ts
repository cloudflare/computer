import type { RunEvent } from "../../shared/events";
import type { ComparisonFixture } from "../../shared/fixture";
import { RunEventRecorder } from "../run-events";
import { createInstrumentedFixtureRuntime } from "./instrumented";
import { type FixtureRuntime, seedFixture } from "./seed";

export interface SandboxFixtureSetupOptions {
  runId: string;
  fixture: ComparisonFixture;
  runtime: FixtureRuntime;
  recorder?: RunEventRecorder;
  now?: () => string;
}

export async function runSandboxFixtureSetup({
  runId,
  fixture,
  runtime,
  recorder,
  now = () => new Date().toISOString(),
}: SandboxFixtureSetupOptions): Promise<RunEvent[]> {
  const eventRecorder = recorder ?? new RunEventRecorder({ runId, now });
  const startIndex = eventRecorder.events().length;

  await seedFixture(
    createInstrumentedFixtureRuntime({
      runtime: "sandbox",
      inner: runtime,
      recorder: eventRecorder,
    }),
    fixture,
  );
  eventRecorder.record({
    runtime: "sandbox",
    kind: "runtime_note",
    title: "Sandbox fixture seeded",
    detail: `Wrote ${fixture.files.length} files through Sandbox SDK file operations at ${fixture.root}.`,
  });

  return eventRecorder.events().slice(startIndex);
}
