import { describe, expect, it } from "vitest";

import { decodeBase32, encodeBase32, randomId } from "./base32.js";

describe("encodeBase32", () => {
  it("encodes the empty input to the empty string", () => {
    expect(encodeBase32(new Uint8Array([]))).toBe("");
  });

  it("encodes one byte to two lowercase characters", () => {
    // 0x00 → 00000 000(00) → "00"
    expect(encodeBase32(new Uint8Array([0x00]))).toBe("00");
    // 0xff → 11111 111(00) → 0x1f, 0x1c → "zw"
    expect(encodeBase32(new Uint8Array([0xff]))).toBe("zw");
  });

  it("uses only lowercase Crockford alphabet characters", () => {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i * 17;
    const encoded = encodeBase32(bytes);
    expect(encoded).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]+$/);
    expect(encoded).not.toMatch(/[ilou]/);
  });

  it("encodes 16 bytes to 26 characters", () => {
    expect(encodeBase32(new Uint8Array(16)).length).toBe(26);
  });
});

describe("decodeBase32", () => {
  it("round-trips arbitrary byte vectors", () => {
    for (const len of [1, 5, 10, 16, 20]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 31 + 7) & 0xff;
      expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
    }
  });

  it("folds ambiguous letters: I/L → 1, O → 0", () => {
    expect(decodeBase32("O0")).toEqual(decodeBase32("00"));
    expect(decodeBase32("I1")).toEqual(decodeBase32("11"));
    expect(decodeBase32("L1")).toEqual(decodeBase32("11"));
  });

  it("accepts uppercase input", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const lower = encodeBase32(bytes);
    expect(decodeBase32(lower.toUpperCase())).toEqual(bytes);
  });

  it("throws on a character outside the alphabet", () => {
    expect(() => decodeBase32("!!")).toThrow(/invalid character/);
  });
});

describe("randomId", () => {
  it("produces a 26-character lowercase token", () => {
    const id = randomId();
    expect(id).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
  });

  it("is unique across calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(randomId());
    expect(ids.size).toBe(1000);
  });

  it("encodes exactly the bytes from the injected source", () => {
    const fixed = new Uint8Array(16).fill(0);
    expect(randomId(() => fixed)).toBe("00000000000000000000000000");
  });
});
