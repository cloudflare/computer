import { describe, expect, it } from "vitest";

import appSource from "./App.tsx?raw";

describe("RLM trace layout", () => {
  it("keeps lane results inside a dedicated trace region with compact worker cards", () => {
    expect(appSource).toContain('className="lane-body"');
    expect(appSource).toContain('className="worker-grid"');
    expect(appSource).toContain("worker worker-");
  });

  it("uses RLM map/reduce language instead of stale transcript and chat language", () => {
    expect(appSource).toContain("Structured RLM");
    expect(appSource).toContain("Model map");
    expect(appSource).toContain("JavaScript reducer output");
    expect(appSource).toContain("Cancel comparison");
    expect(appSource).toContain("Waiting for the RLM map");
    expect(appSource).toContain("All three strategies are overlapping now");
    expect(appSource).toContain("Workers AI charges may apply");
    expect(appSource).not.toContain("Model response");
    expect(appSource).not.toContain("transcript");
  });

  it("shows executor output separately from semantic capability mismatches", () => {
    expect(appSource).toContain("JavaScript execution output");
    expect(appSource).toContain("Capability mismatch");
    expect(appSource).toContain("JavaScript completed, but its output does not fit this task.");
    expect(appSource).toContain("bounded <code>codemode:model</code> map calls");
  });
});
