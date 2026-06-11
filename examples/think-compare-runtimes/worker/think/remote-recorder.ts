import type { RunEvent } from "../../shared/events";
import type { RunEventInput } from "../run-events";

export interface CompareRunEventSink {
  appendEvent(input: RunEventInput): Promise<RunEvent>;
}

export function createRemoteRunEventRecorder(sink: CompareRunEventSink): {
  record(input: RunEventInput): Promise<RunEvent>;
} {
  return {
    record(input) {
      return sink.appendEvent(input);
    },
  };
}
