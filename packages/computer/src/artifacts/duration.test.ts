// Unit tests for the TTL duration parser. Pure logic, no I/O.

import { describe, expect, it } from "vitest";
import { parseDuration } from "./duration.js";

describe("parseDuration", () => {
  it("reads a bare integer as seconds", () => {
    expect(parseDuration("3600")).toBe(3600);
    expect(parseDuration("1")).toBe(1);
  });

  it("converts single-unit durations to seconds", () => {
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("1h")).toBe(3600);
    expect(parseDuration("1d")).toBe(86400);
  });

  it("sums multi-segment durations", () => {
    expect(parseDuration("2h30m")).toBe(2 * 3600 + 30 * 60);
    expect(parseDuration("1h1m1s")).toBe(3600 + 60 + 1);
  });

  it("ignores surrounding whitespace", () => {
    expect(parseDuration("  45s ")).toBe(45);
  });

  it("accepts uppercase unit letters", () => {
    expect(parseDuration("2H")).toBe(7200);
  });

  it("rejects an empty or whitespace-only value", () => {
    expect(() => parseDuration("")).toThrow(RangeError);
    expect(() => parseDuration("   ")).toThrow(RangeError);
  });

  it("rejects zero and negative values", () => {
    expect(() => parseDuration("0")).toThrow(/positive/);
    expect(() => parseDuration("0s")).toThrow(/positive/);
    expect(() => parseDuration("-5")).toThrow(RangeError);
  });

  it("rejects fractional values", () => {
    expect(() => parseDuration("1.5h")).toThrow(RangeError);
  });

  it("rejects unknown units", () => {
    expect(() => parseDuration("5w")).toThrow(/unit/);
  });

  it("rejects trailing or embedded garbage", () => {
    expect(() => parseDuration("30sx")).toThrow(RangeError);
    expect(() => parseDuration("h")).toThrow(RangeError);
    expect(() => parseDuration("10")).not.toThrow();
  });
});
