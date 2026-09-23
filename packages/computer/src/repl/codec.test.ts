// The REPL value codec: capability args, results, and grant data snapshots
// are stored as JSON in the session log, but cells traffic in real JS
// values (Dates, bytes, Maps). The codec is the single translation — it
// must round-trip everything it accepts and loudly reject what it can't,
// because a value that can't be re-served exactly would corrupt replay.
//
// encodeReplValue / decodeReplValue are deliberately self-contained plain
// functions: the same source runs host-side (imported) and isolate-side
// (injected into the runner module via Function.prototype.toString()).

import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";

import { decodeReplValue, encodeReplValue } from "./codec.js";
import { replRunnerModule } from "./runner.js";

function roundTrip(value: unknown): unknown {
  // Through real JSON, exactly like the SQLite log.
  return decodeReplValue(JSON.parse(JSON.stringify(encodeReplValue(value))));
}

describe("encodeReplValue / decodeReplValue", () => {
  it("passes JSON-native values through", () => {
    const value = { a: 1, b: "two", c: [true, null, 3.5], d: { nested: "x" } };
    expect(roundTrip(value)).toEqual(value);
  });

  it("round-trips undefined, including inside objects and arrays", () => {
    expect(roundTrip(undefined)).toBeUndefined();
    expect(roundTrip({ a: undefined })).toEqual({ a: undefined });
    expect(roundTrip([1, undefined, 2])).toEqual([1, undefined, 2]);
  });

  it("round-trips Dates to the millisecond", () => {
    const date = new Date("2026-01-02T03:04:05.678Z");
    const back = roundTrip(date) as Date;
    expect(back).toBeInstanceOf(Date);
    expect(back.getTime()).toBe(date.getTime());
  });

  it("round-trips bigint and non-JSON numbers", () => {
    expect(roundTrip(123n)).toBe(123n);
    expect(roundTrip(Number.NaN)).toBeNaN();
    expect(roundTrip(Infinity)).toBe(Infinity);
    expect(roundTrip(-Infinity)).toBe(-Infinity);
  });

  it("round-trips Uint8Array and ArrayBuffer byte-exact", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const back = roundTrip(bytes) as Uint8Array;
    expect(back).toBeInstanceOf(Uint8Array);
    expect(Array.from(back)).toEqual(Array.from(bytes));

    const buffer = bytes.slice().buffer;
    const backBuffer = roundTrip(buffer) as ArrayBuffer;
    expect(backBuffer).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(backBuffer))).toEqual(Array.from(bytes));
  });

  it("round-trips Map and Set with non-string keys", () => {
    const map = new Map<unknown, unknown>([
      [1, "one"],
      [{ k: 2 }, new Date(1000)],
    ]);
    const backMap = roundTrip(map) as Map<unknown, unknown>;
    expect(backMap).toBeInstanceOf(Map);
    expect([...backMap.entries()]).toEqual([
      [1, "one"],
      [{ k: 2 }, new Date(1000)],
    ]);

    const set = new Set([1, "a", null]);
    expect(roundTrip(set)).toEqual(set);
  });

  it("escapes plain objects that collide with the tag key", () => {
    const value = { $repl: "date", v: 42 };
    expect(roundTrip(value)).toEqual(value);
  });

  it("preserves handle markers as plain data", () => {
    // Handle markers are ordinary tagged objects minted by the recorder;
    // the codec must carry them through unchanged, not decode them away.
    const marker = { $repl: "handle", id: "a1h2" };
    expect(roundTrip(marker)).toEqual(marker);
  });

  it("rejects functions, class instances, and cycles with the fix named", () => {
    expect(() => encodeReplValue(() => 1)).toThrow(/cannot be recorded|plain data/);
    class Widget {
      x = 1;
    }
    expect(() => encodeReplValue(new Widget())).toThrow(/cannot be recorded|plain data/);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => encodeReplValue(cyclic)).toThrow(/cycle/i);
  });

  it("is self-contained enough to inject into the runner template", () => {
    // The runner evals these sources in an isolate with no module scope:
    // they must not reference anything but their own parameters and body.
    const source = `${encodeReplValue.toString()}\n${decodeReplValue.toString()}`;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(
      `${source}\nreturn { encodeReplValue, decodeReplValue };`,
    ) as () => {
      encodeReplValue: typeof encodeReplValue;
      decodeReplValue: typeof decodeReplValue;
    };
    const injected = factory();
    const value = { when: new Date(5), bytes: new Uint8Array([9, 8]) };
    const back = injected.decodeReplValue(
      JSON.parse(JSON.stringify(injected.encodeReplValue(value))),
    ) as typeof value;
    expect(back.when.getTime()).toBe(5);
    expect(Array.from(back.bytes)).toEqual([9, 8]);
  });

  it("survives a consumer bundler's keepNames transform (wrangler's default)", () => {
    // When a consumer bundles this package with esbuild keepNames on (as
    // wrangler does), the codec function bodies get laced with __name(...)
    // helper calls whose definition is hoisted to bundle scope — where
    // Function.prototype.toString() can't see it. Reproduce that here and
    // verify the runner module's prelude makes the injected source work.
    const laced = transformSync(
      `${encodeReplValue.toString()}\n${decodeReplValue.toString()}`,
      { keepNames: true },
    ).code;
    const start = laced.indexOf("function encodeReplValue");
    expect(start).toBeGreaterThan(0);
    // Drop esbuild's inline helper definitions, keeping only what a real
    // bundle's fn.toString() would return: bodies with unbound __name calls.
    const stripped = laced.slice(start);
    expect(stripped).toContain("__name(");

    type Codec = {
      encodeReplValue: typeof encodeReplValue;
      decodeReplValue: typeof decodeReplValue;
    };
    const factory = (prelude: string): Codec =>
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function(
        `${prelude}\n${stripped}\nreturn { encodeReplValue, decodeReplValue };`,
      )() as Codec;

    // Without the prelude, the laced source is broken — the production bug.
    expect(() => factory("")).toThrow(/__name/);

    // The actual prelude emitted by the runner module repairs it.
    const prelude = /const __name = [^;]*;/.exec(replRunnerModule())?.[0];
    expect(prelude).toBeDefined();
    const injected = factory(prelude ?? "");
    const value = { when: new Date(5), bytes: new Uint8Array([9, 8]) };
    const back = injected.decodeReplValue(
      JSON.parse(JSON.stringify(injected.encodeReplValue(value))),
    ) as typeof value;
    expect(back.when.getTime()).toBe(5);
    expect(Array.from(back.bytes)).toEqual([9, 8]);
  });
});
