import { describe, expect, it } from "vitest";

import { authorizeDemoRequest } from "./demo-auth.js";

describe("authorizeDemoRequest", () => {
  it("keeps local development open", () => {
    expect(authorizeDemoRequest(new Request("http://localhost/api/run"), undefined)).toBeNull();
  });

  it("requires a token before deployment", async () => {
    const response = authorizeDemoRequest(
      new Request("https://browser.example.com/api/run"),
      undefined,
    );

    expect(response?.status).toBe(503);
    await expect(response?.text()).resolves.toContain("DEMO_TOKEN");
  });

  it("accepts matching HTTP Basic credentials", () => {
    const authorization = basicAuthorization("demo:secret");
    const request = new Request("https://browser.example.com/api/run", {
      headers: { authorization },
    });

    expect(authorizeDemoRequest(request, "secret")).toBeNull();
  });

  it("accepts a Unicode token encoded as UTF-8", () => {
    const authorization = basicAuthorization("demo:secret-🔒");
    const request = new Request("https://browser.example.com/api/run", {
      headers: { authorization },
    });

    expect(authorizeDemoRequest(request, "secret-🔒")).toBeNull();
  });

  it("challenges missing or incorrect credentials", () => {
    const response = authorizeDemoRequest(
      new Request("https://browser.example.com/api/run"),
      "secret",
    );

    expect(response?.status).toBe(401);
    expect(response?.headers.get("www-authenticate")).toBe(
      'Basic realm="Browser demo", charset="UTF-8"',
    );
  });
});

function basicAuthorization(credentials: string): string {
  const bytes = new TextEncoder().encode(credentials);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}
