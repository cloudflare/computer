import { describe, expect, it } from "vitest";

import { editInStore } from "./edit.js";
import type { FileStore } from "./types.js";

function memoryStore(initial: string) {
  let content = new TextEncoder().encode(initial);
  const store: FileStore = {
    async stat() {
      return { size: content.byteLength, mtime: 1, mode: 0o100644 };
    },
    async *readChunks() {
      yield content;
    },
    async readAll() {
      return content;
    },
    async write(_path, next) {
      content = next;
    },
  };
  return { store, text: () => new TextDecoder().decode(content) };
}

const lines = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`).join("\n");

describe("editInStore diff bounds", () => {
  it("returns the diff and patch of a small edit", async () => {
    const { store, text } = memoryStore("a\nb\nc\n");

    const result = await editInStore(
      { store },
      { path: "/w/f.txt", edits: [{ oldText: "b", newText: "B" }] },
    );

    expect(text()).toBe("a\nB\nc\n");
    expect(result).toMatchObject({ path: "/w/f.txt", editsApplied: 1, firstChangedLine: 2 });
    expect(result).not.toHaveProperty("diffTruncated");
    expect((result as { patch: string }).patch).toContain("-b\n+B");
  });

  it("applies an edit too large to diff and says the diff was skipped", async () => {
    const before = lines(50, "old");
    const { store, text } = memoryStore(`head\n${before}\ntail\n`);

    const result = await editInStore(
      { store, maxDiffLines: 10 },
      { path: "/w/f.txt", edits: [{ oldText: before, newText: lines(50, "new") }] },
    );

    expect(text()).toContain("new49");
    expect(result).toEqual({
      path: "/w/f.txt",
      editsApplied: 1,
      diff: "",
      patch: "",
      firstChangedLine: undefined,
      diffTruncated: true,
    });
  });

  it("counts replaced lines on either side of every edit", async () => {
    const { store } = memoryStore("x\ny\n");

    const result = await editInStore(
      { store, maxDiffLines: 5 },
      {
        path: "/w/f.txt",
        edits: [
          { oldText: "x", newText: lines(3, "a") },
          { oldText: "y", newText: lines(3, "b") },
        ],
      },
    );

    expect(result).toMatchObject({ diffTruncated: true, diff: "" });
  });

  it("cuts a long diff and patch on a character boundary", async () => {
    const { store } = memoryStore("é".repeat(400));

    const result = (await editInStore(
      { store, maxDiffBytes: 101 },
      { path: "/w/f.txt", edits: [{ oldText: "é".repeat(400), newText: "ü".repeat(400) }] },
    )) as { diff: string; patch: string; diffTruncated?: boolean };

    expect(result.diffTruncated).toBe(true);
    expect(new TextEncoder().encode(result.diff).byteLength).toBeLessThanOrEqual(101);
    expect(new TextEncoder().encode(result.patch).byteLength).toBeLessThanOrEqual(101);
    expect(result.diff).not.toContain("\uFFFD");
    expect(result.patch).not.toContain("\uFFFD");
  });
});
