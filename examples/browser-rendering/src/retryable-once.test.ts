import { describe, expect, it, vi } from "vitest";

import { retryableOnce } from "./retryable-once.js";

describe("retryableOnce", () => {
  it("retries a failed attempt and caches the first successful one", async () => {
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValue();
    const run = retryableOnce(operation);

    await expect(run()).rejects.toThrow("write failed");
    await expect(run()).resolves.toBeUndefined();
    await expect(run()).resolves.toBeUndefined();

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("shares an attempt between concurrent callers", async () => {
    let finish: (() => void) | undefined;
    const operation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const run = retryableOnce(operation);

    const first = run();
    const second = run();
    finish?.();
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(operation).toHaveBeenCalledOnce();
  });
});
