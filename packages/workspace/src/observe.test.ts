import { describe, expect, it } from "vitest";
import { noopObserver, withSpan } from "./observe.js";
import { makeRecorder } from "./observe-recorder.js";

describe("noopObserver", () => {
  it("returns the callback's promise unchanged", async () => {
    const result = await noopObserver.span("any", {}, async () => 42);
    expect(result).toBe(42);
  });

  it("propagates rejections from the callback", async () => {
    await expect(
      noopObserver.span("any", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("hands the callback a working setAttribute that does nothing", async () => {
    await noopObserver.span("any", {}, async (span) => {
      expect(() => span.setAttribute("k", "v")).not.toThrow();
      expect(() => span.setAttribute("k", undefined)).not.toThrow();
    });
  });
});

describe("withSpan", () => {
  it("forwards the work's return value", async () => {
    const recorder = makeRecorder();
    const result = await withSpan(recorder, "test.op", { kind: "demo" }, async () => "value");
    expect(result).toBe("value");
    expect(recorder.spans).toHaveLength(1);
    expect(recorder.spans[0].name).toBe("test.op");
    expect(recorder.spans[0].attributes).toEqual({ kind: "demo" });
    expect(recorder.spans[0].outcome).toBe("ok");
  });

  it("drops undefined initial attributes", async () => {
    const recorder = makeRecorder();
    await withSpan(recorder, "test.op", { kept: "yes", missing: undefined }, async () => 0);
    expect(recorder.spans[0].attributes).toEqual({ kept: "yes" });
  });

  it("calls finalize with the work's result on success", async () => {
    const recorder = makeRecorder();
    await withSpan(
      recorder,
      "test.op",
      {},
      async () => 7,
      (span, outcome) => {
        expect(outcome.ok).toBe(true);
        if (outcome.ok) span.setAttribute("doubled", outcome.value * 2);
      },
    );
    expect(recorder.spans[0].attributes).toEqual({ doubled: 14 });
  });

  it("bounds and redacts error messages", async () => {
    const recorder = makeRecorder();
    const secret = "trace-secret";
    await expect(
      withSpan(recorder, "test.op", {}, async () => {
        throw new Error(`failed token=${secret} ${"x".repeat(700)}`);
      }),
    ).rejects.toThrow(secret);
    const recorded = recorder.spans[0].attributes["error.message"];
    expect(recorded.length).toBeLessThanOrEqual(512);
    expect(recorded).toContain("failed token=[REDACTED]");
    expect(recorded).not.toContain(secret);
  });

  it("records error name and message and re-throws", async () => {
    const recorder = makeRecorder();
    await expect(
      withSpan(recorder, "test.op", {}, async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(recorder.spans[0].outcome).toBe("error");
    expect(recorder.spans[0].attributes["error.name"]).toBe("Error");
    expect(recorder.spans[0].attributes["error.message"]).toBe("nope");
  });

  it("stringifies non-Error throws into error.message", async () => {
    const recorder = makeRecorder();
    await expect(
      withSpan(recorder, "test.op", {}, async () => {
        throw "plain";
      }),
    ).rejects.toBe("plain");
    expect(recorder.spans[0].attributes["error.message"]).toBe("plain");
    expect(recorder.spans[0].attributes["error.name"]).toBeUndefined();
  });

  it("invokes finalize on the error path with the thrown value", async () => {
    const recorder = makeRecorder();
    const cause = new Error("fail");
    await expect(
      withSpan(
        recorder,
        "test.op",
        {},
        async () => {
          throw cause;
        },
        (span, outcome) => {
          expect(outcome.ok).toBe(false);
          if (!outcome.ok) span.setAttribute("seen", outcome.error === cause);
        },
      ),
    ).rejects.toBe(cause);
    expect(recorder.spans[0].attributes.seen).toBe(true);
  });

  it("swallows finalize errors so the outcome reaches the caller", async () => {
    const recorder = makeRecorder();
    await expect(
      withSpan(
        recorder,
        "test.op",
        {},
        async () => 1,
        () => {
          throw new Error("ignore me");
        },
      ),
    ).resolves.toBe(1);
  });

  it("nests child spans under the active parent", async () => {
    const recorder = makeRecorder();
    await withSpan(recorder, "parent", {}, async () => {
      await withSpan(recorder, "child", {}, async () => "done");
    });
    expect(recorder.spans).toHaveLength(1);
    expect(recorder.spans[0].name).toBe("parent");
    expect(recorder.spans[0].children.map((c) => c.name)).toEqual(["child"]);
  });
});
