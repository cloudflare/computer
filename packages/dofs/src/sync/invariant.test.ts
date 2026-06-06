import { describe, expect, it } from "vitest";

import { assertAppliedPushCursor } from "./invariant.js";

describe("assertAppliedPushCursor", () => {
  it("passes when applied covers pushed", () => {
    expect(() =>
      assertAppliedPushCursor({ rev: 10, path: null }, { rev: 10, path: null }),
    ).not.toThrow();
    expect(() =>
      assertAppliedPushCursor({ rev: 11, path: "/partial.txt" }, { rev: 10, path: null }),
    ).not.toThrow();
  });

  it("passes at zero", () => {
    expect(() =>
      assertAppliedPushCursor({ rev: 0, path: null }, { rev: 0, path: null }),
    ).not.toThrow();
  });

  it("throws when the receiver only partially applied the pushed rev", () => {
    expect(() =>
      assertAppliedPushCursor({ rev: 10, path: "/partial.txt" }, { rev: 10, path: null }),
    ).toThrowError(/appliedPushCursor.*pushCursor/i);
  });

  it("throws when the receiver is behind the sender's push cursor", () => {
    expect(() =>
      assertAppliedPushCursor({ rev: 5, path: null }, { rev: 10, path: null }),
    ).toThrowError(/appliedPushCursor.*pushCursor/i);
  });
});
