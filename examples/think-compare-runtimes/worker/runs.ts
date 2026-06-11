import type { RunEvent } from "../shared/events";

export interface RunSession {
  runId: string;
  socketPath: string;
  events: RunEvent[];
}

export function createRunSession(createId = () => crypto.randomUUID()): RunSession {
  const runId = createId();

  return {
    runId,
    socketPath: `/parties/compare-run/${runId}`,
    events: [],
  };
}
