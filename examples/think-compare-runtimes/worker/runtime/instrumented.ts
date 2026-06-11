import type { RuntimeId } from "../../shared/events";
import type { RunEventRecorder } from "../run-events";
import type { FixtureRuntime } from "./seed";

export interface InstrumentedFixtureRuntimeOptions {
  runtime: RuntimeId;
  inner: FixtureRuntime;
  recorder: RunEventRecorder;
}

export function createInstrumentedFixtureRuntime({
  runtime,
  inner,
  recorder,
}: InstrumentedFixtureRuntimeOptions): FixtureRuntime {
  return {
    async mkdir(path) {
      recorder.record({
        runtime,
        kind: "tool_call",
        title: `mkdir ${path}`,
        detail: `Creating directory through ${runtime} runtime.`,
      });
      await inner.mkdir(path);
      recorder.record({
        runtime,
        kind: "tool_result",
        title: "mkdir complete",
        detail: `Created ${path}.`,
      });
    },
    async writeFile(path, contents) {
      recorder.record({
        runtime,
        kind: "tool_call",
        title: `write ${path}`,
        detail: `Writing ${new TextEncoder().encode(contents).byteLength} bytes through ${runtime} runtime.`,
      });
      await inner.writeFile(path, contents);
      recorder.record({
        runtime,
        kind: "tool_result",
        title: "write complete",
        detail: `Wrote ${path}.`,
      });
    },
  };
}
