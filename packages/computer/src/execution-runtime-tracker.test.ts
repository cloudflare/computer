import { describe, expect, it } from "vitest";

import { ExecutionRuntimeTracker } from "./execution-runtime-tracker.js";

describe("ExecutionRuntimeTracker", () => {
  it("evicts the least recently used execution at its limit", () => {
    const tracker = new ExecutionRuntimeTracker(2);
    tracker.remember("a", "runtime-a");
    tracker.remember("b", "runtime-a");

    expect(tracker.get("a")).toBe("runtime-a");
    tracker.remember("c", "runtime-b");

    expect(tracker.get("a")).toBe("runtime-a");
    expect(tracker.get("b")).toBeUndefined();
    expect(tracker.get("c")).toBe("runtime-b");
  });

  it("updates an existing execution without growing the cache", () => {
    const tracker = new ExecutionRuntimeTracker(2);
    tracker.remember("a", "runtime-a");
    tracker.remember("b", "runtime-a");
    tracker.remember("a", "runtime-b");
    tracker.remember("c", "runtime-c");

    expect(tracker.get("a")).toBe("runtime-b");
    expect(tracker.get("b")).toBeUndefined();
    expect(tracker.get("c")).toBe("runtime-c");
  });

  it("deletes only the expected runtime owner", () => {
    const tracker = new ExecutionRuntimeTracker(2);
    tracker.remember("a", "runtime-b");

    tracker.delete("a", "runtime-a");
    expect(tracker.get("a")).toBe("runtime-b");

    tracker.delete("a", "runtime-b");
    expect(tracker.get("a")).toBeUndefined();
  });
});
