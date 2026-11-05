import * as $ from "capnp-es";
import { describe, expect, it } from "vitest";
import * as S from "./capnp/exec";
import { FrameReader, FramingError } from "./framing";

/** A real framed message, as capnp-es writes it. */
function frame(text: string): Uint8Array {
  const m = new $.Message();
  m.initRoot(S.Response)._initError().message = text;
  return new Uint8Array(m.toArrayBuffer());
}

/** Hand-built framing: segment sizes in words, then zero-filled segments. */
function rawFrame(sizes: number[]): Uint8Array {
  const header = 4 + 4 * sizes.length + (sizes.length % 2 === 0 ? 4 : 0);
  const out = new Uint8Array(header + sizes.reduce((n, s) => n + s * 8, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, sizes.length - 1, true);
  for (const [i, s] of sizes.entries()) view.setUint32(4 + 4 * i, s, true);
  return out;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function readAll(reader: FrameReader): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (let f = await reader.next(); f !== undefined; f = await reader.next()) out.push(f);
  return out;
}

describe("FrameReader", () => {
  it("returns whole messages and undefined at a clean end", async () => {
    const a = frame("first");
    const b = frame("second, longer");
    const frames = await readAll(new FrameReader(streamOf([concat([a, b])])));
    expect(frames).toEqual([a, b]);
  });

  it("reassembles messages split at every possible byte boundary", async () => {
    const a = frame("split me");
    const b = frame("and me");
    const whole = concat([a, b]);
    for (let cut = 1; cut < whole.byteLength; cut++) {
      const frames = await readAll(
        new FrameReader(streamOf([whole.subarray(0, cut), whole.subarray(cut)])),
      );
      expect(frames, `cut at ${cut}`).toEqual([a, b]);
    }
  });

  it("handles one byte at a time", async () => {
    const a = frame("tiny chunks");
    const bytes = Array.from(a, (b) => new Uint8Array([b]));
    expect(await readAll(new FrameReader(streamOf(bytes)))).toEqual([a]);
  });

  it("handles multi-segment messages with and without table padding", async () => {
    for (const sizes of [[1], [1, 2], [2, 1, 3], [1, 1, 1, 1]]) {
      const raw = rawFrame(sizes);
      expect(await readAll(new FrameReader(streamOf([raw])))).toEqual([raw]);
    }
  });

  it("refuses oversized messages before reading them", async () => {
    const huge = rawFrame([1]);
    new DataView(huge.buffer).setUint32(4, 1024 * 1024, true); // claims 8 MiB
    await expect(new FrameReader(streamOf([huge]), 1024).next()).rejects.toThrow(FramingError);
  });

  it("refuses absurd segment counts", async () => {
    const bad = new Uint8Array(8);
    new DataView(bad.buffer).setUint32(0, 100_000, true);
    await expect(new FrameReader(streamOf([bad])).next()).rejects.toThrow(/segments/);
  });

  it("reports a stream that ends inside a message", async () => {
    const a = frame("cut short");
    for (const cut of [2, 6, a.byteLength - 1]) {
      await expect(
        new FrameReader(streamOf([a.subarray(0, cut)])).next(),
        `cut at ${cut}`,
      ).rejects.toThrow(FramingError);
    }
  });

  it("accepts chunks as ArrayBuffers and other views, as they arrive across Workers RPC", async () => {
    const a = frame("over rpc");
    const half = a.byteLength / 2;
    const chunks = [
      a.slice(0, half).buffer,
      new DataView(a.buffer, a.byteOffset + half),
    ] as unknown as Uint8Array[];
    expect(await readAll(new FrameReader(streamOf(chunks)))).toEqual([a]);
    await expect(
      new FrameReader(streamOf(["text" as unknown as Uint8Array])).next(),
    ).rejects.toThrow(/expected bytes/);
  });

  it("ignores empty chunks", async () => {
    const a = frame("x");
    expect(
      await readAll(new FrameReader(streamOf([new Uint8Array(), a, new Uint8Array()]))),
    ).toEqual([a]);
  });

  it("cancel releases the stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    await new FrameReader(stream).cancel();
    expect(cancelled).toBe(true);
  });
});
