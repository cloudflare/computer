import type { EventRuntime, RunEvent, RunEventKind } from "../shared/events";

export interface RunEventInput {
  runtime: EventRuntime;
  kind: RunEventKind;
  title: string;
  detail: string;
}

export interface RunEventRecorderLike {
  record(input: RunEventInput): RunEvent | Promise<RunEvent>;
}

export interface RunEventRecorderOptions {
  runId: string;
  now?: () => string;
  startSequence?: number;
}

export class RunEventRecorder {
  readonly #runId: string;
  readonly #now: () => string;
  #nextSequence: number;
  readonly #events: RunEvent[] = [];

  constructor({
    runId,
    now = () => new Date().toISOString(),
    startSequence = 0,
  }: RunEventRecorderOptions) {
    this.#runId = runId;
    this.#now = now;
    this.#nextSequence = startSequence;
  }

  record(input: RunEventInput): RunEvent {
    const sequence = this.#nextSequence;
    this.#nextSequence += 1;

    const event: RunEvent = {
      ...input,
      id: `${this.#runId}:${sequence}`,
      runId: this.#runId,
      sequence,
      timestamp: this.#now(),
    };
    this.#events.push(event);
    return event;
  }

  events(): RunEvent[] {
    return [...this.#events];
  }
}
