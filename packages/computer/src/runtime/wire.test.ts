import { describe, expect, it } from "vitest";

import type { WorkspaceRuntimeEvent } from "./types.js";
import { decodeRuntimeEvents, encodeRuntimeEvent } from "./wire.js";

function streamOf(...events: WorkspaceRuntimeEvent[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encodeRuntimeEvent(event));
      controller.close();
    },
  });
}

async function collect(
  stream: ReadableStream<WorkspaceRuntimeEvent>,
): Promise<WorkspaceRuntimeEvent[]> {
  const events: WorkspaceRuntimeEvent[] = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    events.push(next.value as WorkspaceRuntimeEvent);
  }
  return events;
}

describe("runtime wire codec", () => {
  it("round-trips an exit event carrying a structured result", async () => {
    const events = await collect(
      decodeRuntimeEvents(
        streamOf({ id: "e-1", seq: 2, name: "exit", code: 0, result: { a: [1, 2, null] } }),
      ),
    );
    expect(events).toEqual([
      { id: "e-1", seq: 2, name: "exit", code: 0, result: { a: [1, 2, null] } },
    ]);
  });

  it("round-trips an exit event with no result", async () => {
    const events = await collect(
      decodeRuntimeEvents(streamOf({ id: "e-1", seq: 1, name: "exit", code: 1 })),
    );
    expect(events).toEqual([{ id: "e-1", seq: 1, name: "exit", code: 1 }]);
  });
});
