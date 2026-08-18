// Unit tests for the Cloudflare runtime adapter. These tests do not
// boot a workerd isolate; they exercise the adapter against a fake
// `Tracing` implementation that mirrors the runtime contract — open a
// span on `enterSpan`, run the callback, propagate its return value,
// and let exceptions throw through.

import { describe, expect, it } from "vitest";

import { createCloudflareObserver } from "./cloudflare.js";

interface RecordedRuntimeSpan {
  name: string;
  attributes: Record<string, boolean | number | string>;
}

// Fake `Tracing` implementation. Faithfully reproduces the behaviour
// the workspace depends on: the runtime owns the span, the callback's
// return value (or its promise) flows through unchanged, exceptions
// propagate, and `setAttribute` is forwarded onto the span object.
//
// The bytes-used limit, async-context propagation, and 64-byte name
// truncation are runtime concerns the adapter does not duplicate; the
// fake omits them too.
function makeFakeTracing(): {
  tracing: Tracing;
  spans: RecordedRuntimeSpan[];
} {
  const spans: RecordedRuntimeSpan[] = [];
  const tracing: Tracing = {
    enterSpan<T, A extends unknown[]>(
      name: string,
      callback: (span: Span, ...args: A) => T,
      ...args: A
    ): T {
      const recorded: RecordedRuntimeSpan = { name, attributes: {} };
      spans.push(recorded);
      const span = {
        get isTraced() {
          return true;
        },
        setAttribute(key: string, value?: boolean | number | string) {
          if (value === undefined) return;
          recorded.attributes[key] = value;
        },
      } as unknown as Span;
      return callback(span, ...args);
    },
    // The runtime exposes `Span` here as a constructor for instanceof
    // checks; the adapter never reads it, so a no-op value is fine.
    Span: class {} as unknown as typeof Span,
  };
  return { tracing, spans };
}

describe("createCloudflareObserver", () => {
  it("opens one runtime span per workspace span and forwards the name", async () => {
    const { tracing, spans } = makeFakeTracing();
    const observer = createCloudflareObserver({ tracing });
    await observer.span("workspace.fs.readFile", {}, async () => "done");
    expect(spans.map((s) => s.name)).toEqual(["workspace.fs.readFile"]);
  });

  it("forwards seed attributes onto the runtime span", async () => {
    const { tracing, spans } = makeFakeTracing();
    const observer = createCloudflareObserver({ tracing });
    await observer.span(
      "workspace.sync.push",
      { "workspace.backend.id": "primary", count: 7, enabled: true },
      async () => undefined,
    );
    expect(spans[0].attributes).toEqual({
      "workspace.backend.id": "primary",
      count: 7,
      enabled: true,
    });
  });

  it("drops undefined seed attributes", async () => {
    const { tracing, spans } = makeFakeTracing();
    const observer = createCloudflareObserver({ tracing });
    await observer.span(
      "workspace.fs.find",
      { "workspace.fs.path": "/", "workspace.fs.pattern": undefined },
      async () => undefined,
    );
    expect(spans[0].attributes).toEqual({ "workspace.fs.path": "/" });
  });

  it("hands the callback a span wrapper whose setAttribute reaches the runtime", async () => {
    const { tracing, spans } = makeFakeTracing();
    const observer = createCloudflareObserver({ tracing });
    await observer.span("workspace.runtime.exec", {}, async (span) => {
      span.setAttribute("workspace.runtime.exit_code", 0);
      span.setAttribute("workspace.runtime.cwd", "/workspace");
      span.setAttribute("dropped", undefined);
    });
    expect(spans[0].attributes).toEqual({
      "workspace.runtime.exit_code": 0,
      "workspace.runtime.cwd": "/workspace",
    });
  });

  it("returns the callback's value unchanged", async () => {
    const { tracing } = makeFakeTracing();
    const observer = createCloudflareObserver({ tracing });
    const result = await observer.span("test.op", {}, async () => 42);
    expect(result).toBe(42);
  });

  it("propagates rejections through enterSpan", async () => {
    const { tracing } = makeFakeTracing();
    const observer = createCloudflareObserver({ tracing });
    await expect(
      observer.span("test.op", {}, async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
  });

  it("degrades to a pass-through when tracing is undefined", async () => {
    const observer = createCloudflareObserver({ tracing: undefined });
    const result = await observer.span("test.op", { kind: "demo" }, async (span) => {
      // setAttribute on the pass-through span is a no-op but must not
      // throw — callers should not need to branch on whether tracing
      // is configured.
      expect(() => span.setAttribute("k", "v")).not.toThrow();
      return 7;
    });
    expect(result).toBe(7);
  });
});
