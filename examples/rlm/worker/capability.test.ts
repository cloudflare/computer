import type { WorkspaceModuleCallContext } from "@cloudflare/computer";
import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createModelCapability } from "./capability";

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock("ai", () => ({ generateText: generateTextMock }));

const model = { specificationVersion: "v3" } as unknown as LanguageModel;

function hooks() {
  return {
    started: vi.fn(),
    completed: vi.fn(),
    failed: vi.fn(),
  };
}

function successfulResult(text = "ok") {
  return {
    text,
    usage: {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    },
  };
}

function context(signal = new AbortController().signal): WorkspaceModuleCallContext {
  return {
    signal,
    deadline: Date.now() + 1_000,
    access: "read",
    resolvePath: async (path) => path,
  };
}

async function waitForCalls(count: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (generateTextMock.mock.calls.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${count} model calls.`);
}

beforeEach(() => {
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue(successfulResult());
});

describe("recursive model batch capability", () => {
  it("exposes only the batch function", () => {
    const capability = createModelCapability(model, hooks());

    expect(Object.keys(capability)).toEqual(["batch"]);
  });

  it("strictly validates the external argument and request shapes", async () => {
    const capability = createModelCapability(model, hooks());

    await expect(capability.batch([], context())).rejects.toThrow("exactly one argument");
    await expect(capability.batch([null], context())).rejects.toThrow("non-empty array");
    await expect(capability.batch([[]], context())).rejects.toThrow("non-empty array");
    await expect(
      capability.batch([[{ prompt: "classify", input: null, extra: true }], null], context()),
    ).rejects.toThrow("exactly one argument");
    await expect(
      capability.batch([[{ prompt: "classify", input: null, extra: true }]], context()),
    ).rejects.toThrow("Invalid batch request");
    await expect(capability.batch([[{ prompt: "", input: null }]], context())).rejects.toThrow(
      "requires a prompt",
    );
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("enforces the 24-request batch bound", async () => {
    const capability = createModelCapability(model, hooks());
    const requests = Array.from({ length: 25 }, (_, index) => ({
      prompt: `request ${index}`,
      input: null,
    }));

    await expect(capability.batch([requests], context())).rejects.toThrow(
      "cannot exceed 24 requests",
    );
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("allows the host to enforce a run-wide child budget", async () => {
    const observed = hooks();
    const admit = vi.fn(() => false);
    const capability = createModelCapability(model, { ...observed, admit });
    const requests = [{ prompt: "classify", input: "evidence" }];

    await expect(capability.batch([requests], context())).rejects.toThrow(
      "exhausted its child-model call budget",
    );
    expect(admit).toHaveBeenCalledWith(1);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("enforces UTF-8 prompt bytes", async () => {
    const capability = createModelCapability(model, hooks());

    await expect(
      capability.batch([[{ prompt: "é".repeat(8 * 1024 + 1), input: null }]], context()),
    ).rejects.toThrow("16384 bytes");
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("enforces JSON-encoded input bytes", async () => {
    const capability = createModelCapability(model, hooks());
    const maximumBody = "x".repeat(48 * 1024 - 11);

    await expect(
      capability.batch([[{ prompt: "classify", input: { body: maximumBody } }]], context()),
    ).resolves.toHaveLength(1);
    await expect(
      capability.batch([[{ prompt: "classify", input: { body: `${maximumBody}x` } }]], context()),
    ).rejects.toThrow("49152 bytes");
  });

  it("enforces the aggregate encoded request bound before inference", async () => {
    const capability = createModelCapability(model, hooks());
    const requests = Array.from({ length: 24 }, (_, index) => ({
      prompt: `request ${index}`,
      input: { body: "x".repeat(48 * 1024 - 12) },
    }));

    await expect(capability.batch([requests], context())).rejects.toThrow(
      "Model batch request cannot exceed",
    );
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("runs no more than four child requests concurrently and preserves input order", async () => {
    const resolvers: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    generateTextMock.mockImplementation(
      ({ prompt }: { prompt: string }) =>
        new Promise((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          resolvers.push(() => {
            active -= 1;
            resolve(successfulResult(prompt.split("\n", 1)[0]));
          });
        }),
    );
    const capability = createModelCapability(model, hooks());
    const resultPromise = capability.batch(
      [Array.from({ length: 8 }, (_, index) => ({ prompt: `request ${index}`, input: null }))],
      context(),
    );

    await waitForCalls(4);
    expect(generateTextMock).toHaveBeenCalledTimes(4);
    resolvers.splice(0, 4).forEach((resolve) => {
      resolve();
    });
    await waitForCalls(8);
    resolvers.splice(0).forEach((resolve) => {
      resolve();
    });

    const results = await resultPromise;
    expect(maximumActive).toBe(4);
    expect(results).toEqual(
      Array.from({ length: 8 }, (_, index) => ({
        id: expect.any(String),
        index,
        ok: true,
        text: `request ${index}`,
        error: null,
      })),
    );
  });

  it("uses the host model, fixed child instructions, output bound, and provider usage", async () => {
    generateTextMock.mockResolvedValue({
      text: "classification",
      usage: {
        inputTokens: 21,
        outputTokens: undefined,
        totalTokens: null,
      },
    });
    const observer = hooks();
    const capability = createModelCapability(model, observer);
    const signal = new AbortController().signal;

    await expect(
      capability.batch([[{ prompt: "classify", input: { evidence: "safe" } }]], context(signal)),
    ).resolves.toEqual([
      { id: expect.any(String), index: 0, ok: true, text: "classification", error: null },
    ]);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model,
        abortSignal: signal,
        maxOutputTokens: 1024,
        system: expect.stringContaining("focused recursive inference worker"),
      }),
    );
    expect(observer.started).toHaveBeenCalledWith({ id: expect.any(String), index: 0 });
    expect(observer.completed).toHaveBeenCalledWith({
      id: expect.any(String),
      index: 0,
      durationMs: expect.any(Number),
      usage: {
        inputTokens: 21,
        outputTokens: null,
        totalTokens: null,
      },
    });
    expect(observer.failed).not.toHaveBeenCalled();
  });

  it("reports failures with available usage and returns a bounded partial result", async () => {
    const failure = Object.assign(new Error("provider unavailable"), {
      usage: { inputTokens: 7, outputTokens: null, totalTokens: 7 },
    });
    generateTextMock.mockRejectedValue(failure);
    const observer = hooks();
    const capability = createModelCapability(model, observer);

    await expect(
      capability.batch([[{ prompt: "classify", input: null }]], context()),
    ).resolves.toEqual([
      {
        id: expect.any(String),
        index: 0,
        ok: false,
        text: "",
        error: "provider unavailable",
      },
    ]);
    expect(observer.failed).toHaveBeenCalledWith({
      id: expect.any(String),
      index: 0,
      error: "provider unavailable",
      durationMs: expect.any(Number),
      usage: { inputTokens: 7, outputTokens: null, totalTokens: 7 },
    });
    expect(observer.completed).not.toHaveBeenCalled();
  });

  it("propagates host aborts to active inference and stops queued requests", async () => {
    generateTextMock.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
        }),
    );
    const observer = hooks();
    const capability = createModelCapability(model, observer);
    const controller = new AbortController();
    const result = capability.batch(
      [Array.from({ length: 8 }, (_, index) => ({ prompt: `request ${index}`, input: null }))],
      context(controller.signal),
    );

    await waitForCalls(4);
    controller.abort(new Error("stopped"));

    await expect(result).rejects.toThrow("stopped");
    expect(generateTextMock).toHaveBeenCalledTimes(4);
    expect(observer.failed).toHaveBeenCalledTimes(4);
  });

  it("never sends prompts, inputs, or generated text to synchronous hooks", async () => {
    generateTextMock.mockResolvedValue(successfulResult("SECRET_CHILD_TEXT"));
    const observer = hooks();
    const capability = createModelCapability(model, observer);

    await capability.batch(
      [[{ prompt: "SECRET_PROMPT", input: { evidence: "SECRET_INPUT" } }]],
      context(),
    );

    const synchronizedHookData = JSON.stringify({
      started: observer.started.mock.calls,
      completed: observer.completed.mock.calls,
      failed: observer.failed.mock.calls,
    });
    expect(synchronizedHookData).not.toContain("SECRET_PROMPT");
    expect(synchronizedHookData).not.toContain("SECRET_INPUT");
    expect(synchronizedHookData).not.toContain("SECRET_CHILD_TEXT");
  });
});
