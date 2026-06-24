// Unit tests for the exec event wire codec.
//
// The codec frames a stream of WorkspaceExecEvents as JSONL bytes so
// the event stream can cross Workers RPC (which carries byte streams
// but not arbitrary object streams), then inflates it back on the far
// side. These tests run the pure encode/decode round trip in-process.

import { describe, expect, it } from "vitest";

import { decodeExecEvents, encodeExecEvents } from "./exec-wire.js";
import type { WorkspaceExecEvent } from "./shell.js";

function streamOf<T>(items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

async function roundTrip<E extends "utf8" | undefined>(
  events: WorkspaceExecEvent<E>[],
): Promise<WorkspaceExecEvent<E>[]> {
  const bytes = encodeExecEvents(streamOf(events));
  return collect(decodeExecEvents<E>(bytes)) as Promise<WorkspaceExecEvent<E>[]>;
}

describe("exec wire codec — utf8 events", () => {
  it("round-trips stdout/stderr/exit events", async () => {
    const events: WorkspaceExecEvent<"utf8">[] = [
      { id: "x", seq: 0, name: "stdout", value: "hello\n" },
      { id: "x", seq: 1, name: "stderr", value: "oops\n" },
      { id: "x", seq: 2, name: "exit", value: 0 },
    ];
    expect(await roundTrip(events)).toEqual(events);
  });

  it("preserves multi-byte text", async () => {
    const events: WorkspaceExecEvent<"utf8">[] = [
      { id: "x", seq: 0, name: "stdout", value: "café — 日本語 🎉" },
      { id: "x", seq: 1, name: "exit", value: 0 },
    ];
    expect(await roundTrip(events)).toEqual(events);
  });

  it("preserves text containing newlines and JSON metacharacters", async () => {
    const events: WorkspaceExecEvent<"utf8">[] = [
      { id: "x", seq: 0, name: "stdout", value: 'line1\nline2\t{"k":"v"}\n' },
      { id: "x", seq: 1, name: "exit", value: 0 },
    ];
    expect(await roundTrip(events)).toEqual(events);
  });
});

describe("exec wire codec — binary events", () => {
  it("round-trips Uint8Array stdout, including non-utf8 bytes", async () => {
    const value = new Uint8Array([0x00, 0xff, 0xfe, 0x10, 0x80, 0x7f]);
    const events: WorkspaceExecEvent<undefined>[] = [
      { id: "x", seq: 0, name: "stdout", value },
      { id: "x", seq: 1, name: "exit", value: 0 },
    ];
    const out = await roundTrip(events);
    expect(out[0].name).toBe("stdout");
    expect(out[0].value).toBeInstanceOf(Uint8Array);
    expect(Array.from(out[0].value as Uint8Array)).toEqual(Array.from(value));
    expect(out[1]).toEqual({ id: "x", seq: 1, name: "exit", value: 0 });
  });

  it("round-trips an empty byte chunk", async () => {
    const events: WorkspaceExecEvent<undefined>[] = [
      { id: "x", seq: 0, name: "stdout", value: new Uint8Array(0) },
      { id: "x", seq: 1, name: "exit", value: 0 },
    ];
    const out = await roundTrip(events);
    expect(out[0].value).toBeInstanceOf(Uint8Array);
    expect((out[0].value as Uint8Array).byteLength).toBe(0);
  });
});

describe("exec wire codec — framing", () => {
  it("tolerates chunk boundaries that split a JSON line", async () => {
    const events: WorkspaceExecEvent<"utf8">[] = [
      { id: "x", seq: 0, name: "stdout", value: "abc" },
      { id: "x", seq: 1, name: "exit", value: 0 },
    ];
    // Encode, then re-chunk the bytes into tiny pieces to force the
    // decoder to buffer partial lines.
    const encoded = await collect(encodeExecEvents(streamOf(events)));
    const joined = new Uint8Array(encoded.reduce((n, c) => n + c.byteLength, 0));
    let off = 0;
    for (const c of encoded) {
      joined.set(c, off);
      off += c.byteLength;
    }
    const tiny = streamOf(Array.from(joined, (b) => new Uint8Array([b])));
    const out = await collect(decodeExecEvents<"utf8">(tiny));
    expect(out).toEqual(events);
  });

  it("emits an empty event stream for an empty byte stream", async () => {
    const out = await collect(decodeExecEvents(streamOf<Uint8Array>([])));
    expect(out).toEqual([]);
  });
});
