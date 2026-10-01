import { describe, expect, it, vi } from "vitest";

import { puppeteer } from "./index.js";

describe("puppeteer plugin", () => {
  it("installs the bundled client with its Browser Run binding", () => {
    const browser = { fetch: vi.fn() } as unknown as Fetcher;

    const plugin = puppeteer({ browser });

    expect(Object.keys(plugin.modules)).toEqual(["@cloudflare/puppeteer"]);
    expect(plugin.modules["@cloudflare/puppeteer"]).toContain("browserBinding");
    expect(plugin.modules["@cloudflare/puppeteer"]).toContain("withBrowser");
    expect(Object.values(plugin.bindings ?? {})).toEqual([browser]);
  });

  it("rejects a missing Browser Run binding", () => {
    expect(() => puppeteer(undefined as never)).toThrow(/Browser Run binding/);
    expect(() => puppeteer({ browser: {} as never })).toThrow(/Browser Run binding/);
  });
});
