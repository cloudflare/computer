import { describe, expect, it } from "vitest";

import { basename, buildKey, contentDisposition, normalisePrefix } from "./upload.js";

describe("basename", () => {
  it("returns the last path segment", () => {
    expect(basename("/workspace/a/b/image.png")).toBe("image.png");
    expect(basename("image.png")).toBe("image.png");
  });

  it("ignores a trailing slash", () => {
    expect(basename("/workspace/dir/")).toBe("dir");
  });
});

describe("normalisePrefix", () => {
  it("treats undefined and empty as no prefix", () => {
    expect(normalisePrefix(undefined)).toBe("");
    expect(normalisePrefix("")).toBe("");
    expect(normalisePrefix("/")).toBe("");
  });

  it("strips leading and trailing slashes", () => {
    expect(normalisePrefix("/agent-x/")).toBe("agent-x");
    expect(normalisePrefix("agent-x")).toBe("agent-x");
  });

  it("collapses internal slash runs", () => {
    expect(normalisePrefix("/agent-x//sub/")).toBe("agent-x/sub");
  });
});

describe("buildKey", () => {
  it("joins prefix, id, and basename", () => {
    expect(buildKey("/workspace/out/image.png", "/agent-7/", "abc123")).toBe(
      "agent-7/abc123/image.png",
    );
  });

  it("omits the prefix segment when there is no prefix", () => {
    expect(buildKey("/workspace/out/image.png", undefined, "abc123")).toBe("abc123/image.png");
  });

  it("never includes the full VFS path", () => {
    const key = buildKey("/workspace/deep/nested/secret.png", "p", "id0");
    expect(key).toBe("p/id0/secret.png");
    expect(key).not.toContain("deep");
    expect(key).not.toContain("nested");
  });
});

describe("contentDisposition", () => {
  it("formats an inline disposition with a quoted filename", () => {
    expect(contentDisposition("inline", "image.png")).toBe('inline; filename="image.png"');
  });

  it("formats an attachment disposition", () => {
    expect(contentDisposition("attachment", "report.pdf")).toBe(
      'attachment; filename="report.pdf"',
    );
  });

  it("escapes quotes and backslashes in the filename", () => {
    expect(contentDisposition("inline", 'a"b\\c.png')).toBe('inline; filename="a\\"b\\\\c.png"');
  });

  it("adds an RFC 5987 filename* form for non-ASCII names", () => {
    const value = contentDisposition("inline", "résumé.pdf");
    expect(value).toContain("filename*=UTF-8''");
    expect(value).toContain(encodeURIComponent("résumé.pdf"));
  });
});
