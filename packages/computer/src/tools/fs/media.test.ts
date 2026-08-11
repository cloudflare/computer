import { describe, expect, it } from "vitest";

import { detectMedia } from "./media.js";
import type { FileStore } from "./types.js";

const encode = (value: string) => new TextEncoder().encode(value);

function store(content: Uint8Array | string): FileStore {
  const bytes = typeof content === "string" ? encode(content) : content;
  return {
    async stat() {
      return { size: bytes.byteLength, mtime: 1 };
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

describe("detectMedia", () => {
  it.each([
    ["/workspace/image.png", "image", "image/png"],
    ["/workspace/image.JPG", "image", "image/jpeg"],
    ["/workspace/image.gif", "image", "image/gif"],
    ["/workspace/image.webp", "image", "image/webp"],
    ["/workspace/document.pdf", "file", "application/pdf"],
    ["/workspace/config.json", "text", "text/plain"],
    ["/workspace/Dockerfile", "text", "text/plain"],
    ["/workspace/.gitignore", "text", "text/plain"],
    ["/workspace/vector.svg", "text", "text/plain"],
  ] as const)("classifies %s by name", async (path, kind, mediaType) => {
    await expect(detectMedia(store(new Uint8Array()), path, 512)).resolves.toEqual({
      kind,
      mediaType,
    });
  });

  it.each([
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    [new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"],
    [encode("GIF89a"), "image/gif"],
    [new Uint8Array([...encode("RIFF"), 0, 0, 0, 0, ...encode("WEBP")]), "image/webp"],
  ] as const)("recognizes image magic bytes", async (content, mediaType) => {
    await expect(detectMedia(store(content), "/workspace/upload", 512)).resolves.toEqual({
      kind: "image",
      mediaType,
    });
  });

  it("recognizes PDF and SVG prefixes", async () => {
    await expect(detectMedia(store("%PDF-1.7"), "/workspace/upload", 512)).resolves.toEqual({
      kind: "file",
      mediaType: "application/pdf",
    });
    await expect(
      detectMedia(
        store('<?xml version="1.0"?>\n<!-- generated -->\n<svg></svg>'),
        "/workspace/upload",
        512,
      ),
    ).resolves.toEqual({ kind: "text", mediaType: "image/svg+xml" });
  });

  it("distinguishes plausible text from binary data", async () => {
    await expect(
      detectMedia(
        store(new Uint8Array([...encode("name=caf"), 0xe9, 0x0a])),
        "/workspace/config",
        512,
      ),
    ).resolves.toEqual({ kind: "text", mediaType: "text/plain" });
    await expect(
      detectMedia(store(new Uint8Array([0xff, 0xfe])), "/workspace/data", 512),
    ).resolves.toEqual({ kind: "binary", mediaType: "application/octet-stream" });
    await expect(
      detectMedia(store(new Uint8Array([0x61, 0x00, 0x62])), "/workspace/data", 512),
    ).resolves.toEqual({ kind: "binary", mediaType: "application/octet-stream" });
  });

  it("reads only the configured prefix", async () => {
    const calls: Array<{ offset?: number; length?: number }> = [];
    const target = store("plain text");
    const original = target.readChunks.bind(target);
    target.readChunks = async function* (path, offset, length) {
      calls.push({ offset, length });
      yield* original(path, offset, length);
    };

    await detectMedia(target, "/workspace/upload", 4);
    expect(calls).toEqual([{ offset: 0, length: 4 }]);
  });
});
