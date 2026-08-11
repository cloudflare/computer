import { describe, expect, it } from "vitest";

import { readFromStore } from "./read.js";
import type { FileStore } from "./types.js";

const encode = (value: string) => new TextEncoder().encode(value);

function store(content: Uint8Array | string, reportedSize?: number): FileStore {
  const bytes = typeof content === "string" ? encode(content) : content;
  return {
    async stat() {
      return { size: reportedSize ?? bytes.byteLength, mtime: 1 };
    },
    async *readChunks(_path, offset = 0, length) {
      yield bytes.slice(offset, length === undefined ? undefined : offset + length);
    },
    async readAll() {
      return bytes.slice();
    },
    async write() {},
  };
}

describe("readFromStore", () => {
  it("returns structured text and enforces line and byte caps", async () => {
    await expect(
      readFromStore(
        { store: store("first\nsecond\nthird\n"), maxLines: 2 },
        { path: "/workspace/file.txt" },
      ),
    ).resolves.toEqual({
      path: "/workspace/file.txt",
      content: "first\nsecond",
      startLine: 1,
      endLine: 2,
      totalLines: null,
      truncated: true,
      nextOffset: 3,
      nextByteOffset: 13,
    });

    await expect(
      readFromStore({ store: store("abcdef\n"), maxBytes: 3 }, { path: "/workspace/file.txt" }),
    ).resolves.toEqual({
      error:
        "Line 1 exceeds the 3-byte read cap. The host must increase maxBytes, reduce lineTruncation, or provide a byte-oriented tool.",
    });
  });

  it("continues directly from a returned byte position", async () => {
    const target = store("first\nsecond\nthird\n");
    const first = await readFromStore(
      { store: target, maxLines: 1 },
      { path: "/workspace/file.txt" },
    );
    expect(first).toMatchObject({ nextOffset: 2, nextByteOffset: 6 });

    await expect(
      readFromStore(
        { store: target, maxLines: 1 },
        { path: "/workspace/file.txt", offset: 2, byteOffset: 6 },
      ),
    ).resolves.toMatchObject({
      content: "second",
      startLine: 2,
      endLine: 2,
      nextOffset: 3,
      nextByteOffset: 13,
    });
  });

  it("requires a line position with a positive byte continuation", async () => {
    await expect(
      readFromStore(
        { store: store("first\nsecond\n") },
        { path: "/workspace/file.txt", byteOffset: 6 },
      ),
    ).resolves.toEqual({ error: "offset is required when byteOffset is greater than zero" });
  });

  it("truncates individual lines on UTF-8 boundaries", async () => {
    await expect(
      readFromStore(
        { store: store("ééé\n"), lineTruncation: { bytes: 5 } },
        { path: "/workspace/file.txt" },
      ),
    ).resolves.toMatchObject({ content: "éé... (truncated)", truncated: false });
  });

  it("captures bounded media bytes and rejects empty attachments", async () => {
    await expect(
      readFromStore(
        { store: store(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) },
        { path: "/workspace/image.png" },
      ),
    ).resolves.toMatchObject({
      kind: "image",
      mediaType: "image/png",
      sizeBytes: 4,
      data: "iVBORw==",
    });

    await expect(
      readFromStore({ store: store(new Uint8Array()) }, { path: "/workspace/image.png" }),
    ).resolves.toEqual({ error: "Cannot attach empty file: /workspace/image.png" });
    await expect(
      readFromStore({ store: store(new Uint8Array(), 10) }, { path: "/workspace/image.png" }),
    ).resolves.toEqual({ error: "Cannot attach empty file: /workspace/image.png" });
  });

  it("validates bounded media options without constructing an AI tool", () => {
    expect(() =>
      readFromStore({ store: store("text"), mediaSniffBytes: 0 }, { path: "/workspace/file" }),
    ).toThrow("mediaSniffBytes must be a positive safe integer");
  });
});
