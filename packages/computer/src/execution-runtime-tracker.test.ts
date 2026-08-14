import { describe, expect, it } from "vitest";

import {
  type ExecutionRuntimeStore,
  ExecutionRuntimeTracker,
} from "./execution-runtime-tracker.js";

function durableStore(backing = new Map<string, string>()): ExecutionRuntimeStore {
  return {
    get: (key) => backing.get(key),
    remember: (key, runtimeId) => backing.set(key, runtimeId),
    delete: (key, expectedRuntimeId) => {
      if (expectedRuntimeId === undefined || backing.get(key) === expectedRuntimeId) {
        backing.delete(key);
      }
    },
  };
}

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

  it("falls back to durable state after cache eviction", () => {
    const store = durableStore();
    const tracker = new ExecutionRuntimeTracker(2, store);
    tracker.remember("a", "runtime-a");
    tracker.remember("b", "runtime-b");
    tracker.remember("c", "runtime-c");

    expect(tracker.get("a")).toBe("runtime-a");
  });

  it("restores runtime ownership in a new Workspace incarnation", () => {
    const store = durableStore();
    const first = new ExecutionRuntimeTracker(2, store);
    first.remember("execution", "runtime-a");

    const recreated = new ExecutionRuntimeTracker(2, store);
    expect(recreated.get("execution")).toBe("runtime-a");
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
