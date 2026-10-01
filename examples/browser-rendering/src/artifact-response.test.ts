import { describe, expect, it } from "vitest";

import { artifactResponseHeaders } from "./artifact-response.js";

describe("artifactResponseHeaders", () => {
  it.each([
    ["report.md", "text/markdown; charset=utf-8"],
    ["page.json", "application/json; charset=utf-8"],
    ["screenshot.png", "image/png"],
  ])("serves %s without allowing content sniffing", (filename, mediaType) => {
    const headers = artifactResponseHeaders(filename);

    expect(headers).toMatchObject({
      "content-type": mediaType,
      "content-disposition": `inline; filename="${filename}"`,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    });
  });
});
