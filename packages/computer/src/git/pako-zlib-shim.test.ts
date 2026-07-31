import * as zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import pako, { deflate, Inflate, inflate } from "./pako-zlib-shim.js";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function asBytes(value: Uint8Array | string): Uint8Array {
  expect(value).toBeInstanceOf(Uint8Array);
  return value as Uint8Array;
}

describe("pako zlib shim", () => {
  it("deflates and inflates pako-style Uint8Array values through node:zlib", () => {
    const input = bytes("hello from git objects\n");

    const compressed = asBytes(deflate(input));
    expect(zlib.inflateSync(compressed).toString("utf8")).toBe("hello from git objects\n");

    const roundTrip = asBytes(inflate(compressed));
    expect(new TextDecoder().decode(roundTrip)).toBe("hello from git objects\n");
  });

  it("exposes a default pako-compatible object", () => {
    expect(pako.deflate).toBe(deflate);
    expect(pako.inflate).toBe(inflate);
    expect(pako.Inflate).toBe(Inflate);
    expect(typeof pako.Z_FINISH).toBe("number");
  });

  it("tracks unused compressed bytes for isomorphic-git's pack parser", () => {
    const first = asBytes(deflate(bytes("first object")));
    const extra = bytes("NEXT");
    const streamBytes = new Uint8Array(first.length + extra.length);
    streamBytes.set(first);
    streamBytes.set(extra, first.length);

    const inflator = new Inflate();
    const split = 2;

    expect(inflator.push(streamBytes.subarray(0, split), false)).toBe(true);
    expect(inflator.result).toBeUndefined();
    expect(inflator.err).toBe(0);

    expect(inflator.push(streamBytes.subarray(split), false)).toBe(true);
    expect(new TextDecoder().decode(inflator.result)).toBe("first object");
    expect(inflator.strm.avail_in).toBe(extra.length);
    expect(inflator.err).toBe(0);
  });

  it("reports corrupt input like pako.Inflate instead of throwing", () => {
    const inflator = new Inflate();

    expect(inflator.push(bytes("not deflate data"), true)).toBe(false);
    expect(inflator.result).toBeUndefined();
    expect(inflator.err).not.toBe(0);
    expect(inflator.msg).toContain("incorrect");
  });
});
