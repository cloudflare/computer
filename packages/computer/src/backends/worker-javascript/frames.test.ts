import { describe, expect, it } from "vitest";

import { decodeRuntimeFrames, parseRuntimeFrame, type RuntimeFrame } from "./frames.js";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<RuntimeFrame>): Promise<RuntimeFrame[]> {
  const frames: RuntimeFrame[] = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    frames.push(next.value);
  }
  return frames;
}

const b64 = (text: string) => btoa(text);

describe("parseRuntimeFrame", () => {
  it("decodes a base64 stdout frame into raw bytes", () => {
    const frame = parseRuntimeFrame(`{"name":"stdout","b64":"${b64("hello")}"}`);
    expect(frame).toEqual({ name: "stdout", value: new TextEncoder().encode("hello") });
  });

  it("decodes a base64 stderr frame into raw bytes", () => {
    const frame = parseRuntimeFrame(`{"name":"stderr","b64":"${b64("oops")}"}`);
    expect(frame).toEqual({ name: "stderr", value: new TextEncoder().encode("oops") });
  });

  it("decodes an exit frame carrying an integer", () => {
    expect(parseRuntimeFrame(`{"name":"exit","value":0}`)).toEqual({ name: "exit", value: 0 });
    expect(parseRuntimeFrame(`{"name":"exit","value":130}`)).toEqual({ name: "exit", value: 130 });
  });

  it("decodes an exit frame carrying a structured result", () => {
    const frame = parseRuntimeFrame(`{"name":"exit","value":0,"result":{"a":[1,2,null]}}`);
    expect(frame).toEqual({ name: "exit", value: 0, result: { a: [1, 2, null] } });
  });

  it("decodes an exit frame carrying a null result", () => {
    const frame = parseRuntimeFrame(`{"name":"exit","value":0,"result":null}`);
    expect(frame).toEqual({ name: "exit", value: 0, result: null });
  });

  it("rejects invalid JSON", () => {
    expect(() => parseRuntimeFrame("not json")).toThrow();
  });

  it("rejects an unknown frame name", () => {
    expect(() => parseRuntimeFrame(`{"name":"other","value":1}`)).toThrow();
  });

  it("rejects a malformed stdout frame missing its payload", () => {
    expect(() => parseRuntimeFrame(`{"name":"stdout"}`)).toThrow();
  });

  it("rejects an exit frame whose value is not an integer", () => {
    expect(() => parseRuntimeFrame(`{"name":"exit","value":"x"}`)).toThrow();
  });
});

describe("decodeRuntimeFrames", () => {
  it("decodes newline-delimited frames arriving in one chunk", async () => {
    const frames = await collect(
      decodeRuntimeFrames(
        streamOf(`{"name":"stdout","b64":"${b64("hi")}"}\n{"name":"exit","value":0}\n`),
      ),
    );
    expect(frames).toEqual([
      { name: "stdout", value: new TextEncoder().encode("hi") },
      { name: "exit", value: 0 },
    ]);
  });

  it("reassembles a frame split across chunk boundaries", async () => {
    const line = `{"name":"stdout","b64":"${b64("split")}"}\n`;
    const mid = Math.floor(line.length / 2);
    const frames = await collect(
      decodeRuntimeFrames(streamOf(line.slice(0, mid), line.slice(mid))),
    );
    expect(frames).toEqual([{ name: "stdout", value: new TextEncoder().encode("split") }]);
  });

  it("emits a trailing frame that arrives without a final newline", async () => {
    const frames = await collect(decodeRuntimeFrames(streamOf(`{"name":"exit","value":1}`)));
    expect(frames).toEqual([{ name: "exit", value: 1 }]);
  });

  it("skips blank lines between frames", async () => {
    const frames = await collect(decodeRuntimeFrames(streamOf(`{"name":"exit","value":0}\n\n`)));
    expect(frames).toEqual([{ name: "exit", value: 0 }]);
  });

  it("errors the stream on a malformed frame", async () => {
    await expect(collect(decodeRuntimeFrames(streamOf(`garbage\n`)))).rejects.toThrow();
  });
});
