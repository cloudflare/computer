import { describe, expect, it, vi } from "vitest";

import { mimeType, parseShellFetchResult, targetUrl, workspaceEgressPolicy } from "./egress.js";

describe("workspaceEgressPolicy", () => {
  it("blocks egress in none mode", () => {
    const gateway = vi.fn<() => Fetcher>();

    expect(workspaceEgressPolicy("none", gateway)).toEqual({ mode: "none" });
    expect(gateway).not.toHaveBeenCalled();
  });

  it("uses direct egress in all mode", () => {
    const gateway = vi.fn<() => Fetcher>();

    expect(workspaceEgressPolicy("all", gateway)).toEqual({ mode: "direct" });
    expect(gateway).not.toHaveBeenCalled();
  });

  it("uses the custom HTTP gateway in custom mode", () => {
    const fetcher = { fetch: vi.fn() } as unknown as Fetcher;
    const gateway = vi.fn(() => fetcher);

    expect(workspaceEgressPolicy("custom", gateway)).toEqual({
      mode: "http-gateway",
      gateway: fetcher,
      revision: "v1",
    });
    expect(gateway).toHaveBeenCalledOnce();
  });

  it("rejects unsupported modes", () => {
    expect(() => workspaceEgressPolicy("invalid", vi.fn())).toThrow(
      'EGRESS_MODE must be "none", "all", or "custom"; got "invalid"',
    );
  });
});

describe("mimeType", () => {
  it("removes content type parameters", () => {
    expect(mimeType("text/html; charset=UTF-8")).toBe("text/html");
  });

  it("returns null for a missing content type", () => {
    expect(mimeType(null)).toBeNull();
    expect(mimeType("")).toBeNull();
  });
});

describe("targetUrl", () => {
  it("accepts HTTP and HTTPS URLs", () => {
    expect(targetUrl("https://example.com/path")).toBe("https://example.com/path");
    expect(targetUrl("http://example.com")).toBe("http://example.com/");
  });

  it("rejects missing, malformed, and non-HTTP URLs", () => {
    expect(() => targetUrl(null)).toThrow("url query parameter is required");
    expect(() => targetUrl("not a URL")).toThrow("url must be a valid HTTP or HTTPS URL");
    expect(() => targetUrl("ftp://example.com/file")).toThrow(
      "url must be a valid HTTP or HTTPS URL",
    );
  });
});

describe("parseShellFetchResult", () => {
  it("returns the status and MIME type from curl output", () => {
    expect(parseShellFetchResult(0, "204\ntext/plain; charset=utf-8", "")).toEqual({
      status: 204,
      mimeType: "text/plain",
    });
  });

  it("returns an error when curl fails", () => {
    expect(parseShellFetchResult(7, "", "curl: network access denied\n")).toEqual({
      error: "curl: network access denied",
    });
  });

  it("returns an error for malformed curl output", () => {
    expect(parseShellFetchResult(0, "not-a-status\ntext/plain", "")).toEqual({
      error: "curl returned an invalid status code",
    });
  });
});
