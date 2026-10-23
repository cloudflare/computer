import { describe, expect, it } from "vitest";

import { canonicalizePath } from "./path";

describe("canonicalizePath", () => {
  it("requires an absolute path", () => {
    expect(() => canonicalizePath("workspace/file.txt")).toThrowError(/must be absolute/);
  });

  it("normalizes duplicate slashes and dot segments", () => {
    expect(canonicalizePath("/workspace//src/./index.ts")).toEqual({
      path: "/workspace/src/index.ts",
      parts: ["workspace", "src", "index.ts"],
      name: "index.ts",
      parentPath: "/workspace/src",
    });
  });

  it("canonicalizes parent segments without escaping root", () => {
    expect(canonicalizePath("/workspace/src/../README.md").path).toBe("/workspace/README.md");
    expect(() => canonicalizePath("/..")).toThrowError(/escapes root/);
  });

  it("represents root explicitly", () => {
    expect(canonicalizePath("/")).toEqual({
      path: "/",
      parts: [],
      name: "",
      parentPath: undefined,
    });
  });
});
