import { describe, expect, it } from "vitest";

import { utf8ByteLength } from "./text-truncation.js";

const encoder = new TextEncoder();

describe("utf8ByteLength", () => {
  it.each([
    ["empty", ""],
    ["ASCII", "hello"],
    ["two-byte characters", "é".repeat(5)],
    ["three-byte characters", "日本語"],
    ["a surrogate pair", "😀"],
    ["a lone high surrogate", "a\uD800b"],
    ["a lone low surrogate", "a\uDC00b"],
    ["a high surrogate at the end", "a\uD800"],
    ["mixed text", "a é 日 😀 \uD800"],
  ])("matches TextEncoder for %s", (_label, value) => {
    expect(utf8ByteLength(value)).toBe(encoder.encode(value).byteLength);
  });
});
