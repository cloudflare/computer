import { describe, expect, it } from "vitest";

import { contentTypeForPath, DEFAULT_CONTENT_TYPE } from "./mime.js";

describe("contentTypeForPath", () => {
  it("maps known image extensions", () => {
    expect(contentTypeForPath("/workspace/a/image.png")).toBe("image/png");
    expect(contentTypeForPath("photo.JPG")).toBe("image/jpeg");
    expect(contentTypeForPath("diagram.svg")).toBe("image/svg+xml");
  });

  it("maps known text and data extensions", () => {
    expect(contentTypeForPath("notes.txt")).toBe("text/plain");
    expect(contentTypeForPath("README.md")).toBe("text/markdown");
    expect(contentTypeForPath("data.json")).toBe("application/json");
  });

  it("is case-insensitive on the extension", () => {
    expect(contentTypeForPath("ARCHIVE.ZIP")).toBe("application/zip");
  });

  it("falls back for an unknown extension", () => {
    expect(contentTypeForPath("mystery.qqq")).toBe(DEFAULT_CONTENT_TYPE);
  });

  it("falls back when there is no extension", () => {
    expect(contentTypeForPath("/workspace/Makefile")).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeForPath("noext")).toBe(DEFAULT_CONTENT_TYPE);
  });

  it("treats a leading-dot dotfile as having no extension", () => {
    expect(contentTypeForPath("/workspace/.gitignore")).toBe(DEFAULT_CONTENT_TYPE);
  });

  it("uses the basename, ignoring dots in parent directories", () => {
    expect(contentTypeForPath("/workspace/v1.2/file.png")).toBe("image/png");
  });
});
