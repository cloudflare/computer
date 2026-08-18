import { describe, expect, it } from "vitest";

import { DEFAULT_IGNORE, isIgnored } from "./ignore.js";

describe("isIgnored", () => {
  const list = ["node_modules", ".next", "target"];

  it("has no default exclusions", () => {
    expect(DEFAULT_IGNORE).toEqual([]);
    expect(isIgnored("/node_modules/package/index.js", DEFAULT_IGNORE)).toBe(false);
  });

  it("returns false for paths that don't intersect the list", () => {
    expect(isIgnored("/src/index.ts", list)).toBe(false);
    expect(isIgnored("/README.md", list)).toBe(false);
    expect(isIgnored("/", list)).toBe(false);
  });

  it("matches the segment exactly, not as a substring", () => {
    expect(isIgnored("/node_modules", list)).toBe(true);
    expect(isIgnored("/node_modules_old", list)).toBe(false);
    expect(isIgnored("/my_node_modules", list)).toBe(false);
  });

  it("matches anywhere in the path", () => {
    expect(isIgnored("/a/b/node_modules", list)).toBe(true);
    expect(isIgnored("/a/b/node_modules/c.js", list)).toBe(true);
    expect(isIgnored("/packages/x/node_modules/y/index.js", list)).toBe(true);
  });

  it("matches nested ignored dirs too", () => {
    expect(isIgnored("/a/.next/cache", list)).toBe(true);
    expect(isIgnored("/rust/target/debug/foo", list)).toBe(true);
  });

  it("returns false for an empty list", () => {
    expect(isIgnored("/anywhere/node_modules", [])).toBe(false);
  });
});
