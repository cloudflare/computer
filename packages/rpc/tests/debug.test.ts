import { describe, expect, it } from "vitest";

import { enableStubTracking, stubSnapshot, trackStub, untrackStub } from "../src/debug.js";

describe("stub leak tracking", () => {
  it("counts target identities and ignores repeated disposal", () => {
    enableStubTracking();

    class DebugTrackerTarget {}

    const first = new DebugTrackerTarget();
    const second = new DebugTrackerTarget();

    trackStub(first);
    trackStub(second);
    expect(stubSnapshot().DebugTrackerTarget).toBe(2);

    untrackStub(first);
    expect(stubSnapshot().DebugTrackerTarget).toBe(1);

    untrackStub(first);
    expect(stubSnapshot().DebugTrackerTarget).toBe(1);

    untrackStub(second);
    expect(stubSnapshot().DebugTrackerTarget).toBeUndefined();
  });
});
