import type { RunEvent } from "../shared/events";
import { createRunSession, type RunSession } from "./runs";

export interface CompareRunStarter {
  startComparison(): Promise<RunEvent[]>;
}

export interface StartComparisonRunOptions {
  createId?: () => string;
  getRun(runId: string): CompareRunStarter | Promise<CompareRunStarter>;
}

export async function startComparisonRun({
  createId,
  getRun,
}: StartComparisonRunOptions): Promise<RunSession> {
  const session = createRunSession(createId);
  const run = await getRun(session.runId);
  const events = await run.startComparison();

  return { ...session, events };
}
