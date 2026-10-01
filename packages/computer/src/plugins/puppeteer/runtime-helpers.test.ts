import { describe, expect, it, vi } from "vitest";

import { createBindingForwarder, withClosable } from "./runtime-helpers.js";

describe("Puppeteer runtime helpers", () => {
  it("forwards fetches to the current Browser Run binding", async () => {
    const response = new Response("ok");
    const fetch = vi.fn(async () => response);
    const resolve = vi.fn(() => ({ fetch }));
    const forwarder = createBindingForwarder(resolve);
    const init = { method: "POST" } satisfies RequestInit;

    await expect(forwarder.fetch("https://browser.example/session", init)).resolves.toBe(response);
    expect(resolve).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("https://browser.example/session", init);
  });

  it("closes the browser after a successful callback", async () => {
    const browser = { close: vi.fn(async () => undefined) };

    await expect(withClosable(browser, async () => "done")).resolves.toBe("done");
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("closes the browser and preserves a callback failure", async () => {
    const browser = { close: vi.fn(async () => undefined) };
    const failure = new Error("page failed");

    await expect(
      withClosable(browser, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("reports a close failure after a successful callback", async () => {
    const closeFailure = new Error("close failed");
    const browser = {
      close: vi.fn(async () => {
        throw closeFailure;
      }),
    };

    await expect(withClosable(browser, async () => "done")).rejects.toBe(closeFailure);
  });

  it("preserves both callback and close failures", async () => {
    const callbackFailure = new Error("page failed");
    const closeFailure = new Error("close failed");
    const browser = {
      close: vi.fn(async () => {
        throw closeFailure;
      }),
    };

    const error = await withClosable(browser, async () => {
      throw callbackFailure;
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([callbackFailure, closeFailure]);
    expect((error as AggregateError).cause).toBe(callbackFailure);
  });
});
