import { describe, expect, it } from "vitest";

import {
  decodeFiles,
  encodeFiles,
  type FileHeader,
  FileTransferConflictError,
  FileTransferError,
  isTransferPath,
  normalizeTransferPattern,
  type OutgoingFile,
  splitPatternBase,
} from "./files.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function file(path: string, text: string, extra: Partial<FileHeader> = {}): OutgoingFile {
  const bytes = encoder.encode(text);
  return {
    header: { path, size: bytes.length, mtime: 1_000, mode: 0o644, ...extra },
    body: async () => bytes,
  };
}

// A stream that hands out `bytes` in chunks of `size`, so the decoder
// has to reassemble headers that straddle chunk boundaries.
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeAll(stream: ReadableStream<Uint8Array>) {
  const out: Array<{ header: FileHeader; text: string }> = [];
  for await (const incoming of decodeFiles(stream)) {
    out.push({ header: incoming.header, text: await new Response(incoming.body).text() });
  }
  return out;
}

describe("encodeFiles and decodeFiles", () => {
  it("round-trip files, including empty ones, across any chunking", async () => {
    const bytes = await collect(
      encodeFiles([
        file("a.txt", "hello"),
        file("dir/empty", ""),
        file("dir/b.js", "x".repeat(10_000), { mode: 0o755, mtime: 2_500 }),
      ]),
    );
    for (const size of [1, 3, 7, 4096, bytes.length]) {
      const files = await decodeAll(chunked(bytes, size));
      expect(files.map((f) => f.header)).toEqual([
        { path: "a.txt", size: 5, mtime: 1_000, mode: 0o644 },
        { path: "dir/empty", size: 0, mtime: 1_000, mode: 0o644 },
        { path: "dir/b.js", size: 10_000, mtime: 2_500, mode: 0o755 },
      ]);
      expect(files.map((f) => f.text.length)).toEqual([5, 0, 10_000]);
      expect(files[0]?.text).toBe("hello");
    }
  });

  it("encodes an empty transfer as just the terminator", async () => {
    const bytes = await collect(encodeFiles([]));
    expect([...bytes]).toEqual([0, 0, 0, 0]);
    expect(await decodeAll(chunked(bytes, 4))).toEqual([]);
  });

  it("streams bodies supplied as ReadableStreams", async () => {
    const stream = encodeFiles([
      {
        header: { path: "s.txt", size: 6, mtime: 0, mode: 0o600 },
        body: async () => chunked(encoder.encode("abcdef"), 2),
      },
    ]);
    expect(await decodeAll(stream)).toEqual([
      { header: { path: "s.txt", size: 6, mtime: 0, mode: 0o600 }, text: "abcdef" },
    ]);
  });

  it("skips a body the consumer leaves unread", async () => {
    const stream = encodeFiles([file("skip", "unread bytes"), file("keep", "kept")]);
    const seen: string[] = [];
    for await (const incoming of decodeFiles(stream)) {
      if (incoming.header.path === "keep") seen.push(await new Response(incoming.body).text());
    }
    expect(seen).toEqual(["kept"]);
  });

  it("errors when a body is shorter or longer than its header says", async () => {
    const short: OutgoingFile = {
      header: { path: "short", size: 10, mtime: 0, mode: 0o644 },
      body: async () => chunked(encoder.encode("abc"), 2),
    };
    await expect(collect(encodeFiles([short]))).rejects.toThrow(/short changed while it was sent/);

    const long: OutgoingFile = {
      header: { path: "long", size: 2, mtime: 0, mode: 0o644 },
      body: async () => chunked(encoder.encode("abcdef"), 4),
    };
    await expect(collect(encodeFiles([long]))).rejects.toThrow(/long changed while it was sent/);
  });

  it("refuses headers with unsafe paths or bad numbers", async () => {
    for (const header of [
      { path: "../escape", size: 0, mtime: 0, mode: 0o644 },
      { path: "/abs", size: 0, mtime: 0, mode: 0o644 },
      { path: "ok", size: -1, mtime: 0, mode: 0o644 },
      { path: "ok", size: 0, mtime: 0, mode: 0o17777 },
    ]) {
      await expect(
        collect(encodeFiles([{ header, body: async () => new Uint8Array(0) }])),
      ).rejects.toBeInstanceOf(FileTransferError);
    }
  });

  it("rejects a transfer that ends before its terminator", async () => {
    const bytes = await collect(encodeFiles([file("a.txt", "hello")]));
    // Every proper prefix is a cut-short transfer, whether it ends in
    // a length prefix, a header, a body, or right before the terminator.
    for (const end of [0, 2, 6, bytes.length - 6, bytes.length - 1]) {
      await expect(decodeAll(chunked(bytes.slice(0, end), 3))).rejects.toThrow(/ended early/);
    }
  });

  it("rejects trailing bytes and oversized headers", async () => {
    const bytes = await collect(encodeFiles([]));
    const trailing = new Uint8Array([...bytes, 1]);
    await expect(decodeAll(chunked(trailing, 8))).rejects.toThrow(/after its terminator/);
    const huge = new Uint8Array([0x7f, 0xff, 0xff, 0xff]);
    await expect(decodeAll(chunked(huge, 4))).rejects.toThrow(/over the limit/);
  });

  it("carries a revision when the header has one, and refuses a bad one", async () => {
    const files = await decodeAll(encodeFiles([file("a", "x", { rev: 42 }), file("b", "y")]));
    expect(files.map((f) => f.header.rev)).toEqual([42, undefined]);
    expect("rev" in (files[1]?.header ?? {})).toBe(false);
    for (const rev of [-1, 1.5, Number.NaN]) {
      await expect(collect(encodeFiles([file("a", "x", { rev })]))).rejects.toThrow(/Invalid rev/);
    }
  });

  it("decodes header JSON as UTF-8", async () => {
    const files = await decodeAll(encodeFiles([file("données/é.txt", "ü")]));
    expect(files[0]?.header.path).toBe("données/é.txt");
    expect(files[0]?.header.size).toBe(2);
    expect(decoder.decode(encoder.encode(files[0]?.text))).toBe("ü");
  });
});

describe("FileTransferConflictError", () => {
  it("names the conflicting paths, a bounded number of them, and the way out", () => {
    const conflicts = Array.from({ length: 12 }, (_, i) => ({
      path: `f${i}`,
      reason: "modified" as const,
      localRev: 9,
      baseRev: 3,
    }));
    const error = new FileTransferConflictError(conflicts);
    expect(error.conflicts).toHaveLength(12);
    expect(error.message).toContain("12 files changed in both");
    expect(error.message).toContain("f0, f1");
    expect(error.message).toContain("and 2 more");
    expect(error.message).not.toContain("f11");
    expect(error.message).toContain("force: true");
  });
});

describe("isTransferPath", () => {
  it("accepts relative paths and refuses anything that could escape", () => {
    expect(isTransferPath("a")).toBe(true);
    expect(isTransferPath("a/b.c")).toBe(true);
    for (const path of ["", "/a", "a/", "a//b", "./a", "a/../b", "..", "a\0b", 3]) {
      expect(isTransferPath(path), String(path)).toBe(false);
    }
  });
});

describe("normalizeTransferPattern", () => {
  const root = "/workspace";

  it("keeps globs and expands a literal path to the path and its contents", () => {
    expect(normalizeTransferPattern("**/*.js", root)).toEqual(["**/*.js"]);
    expect(normalizeTransferPattern("./dist", root)).toEqual(["dist", "dist/**"]);
    expect(normalizeTransferPattern("dist/", root)).toEqual(["dist", "dist/**"]);
    expect(normalizeTransferPattern("package.json", root)).toEqual([
      "package.json",
      "package.json/**",
    ]);
  });

  it("accepts absolute patterns under the root, and the root itself", () => {
    expect(normalizeTransferPattern("/workspace/src/*.ts", root)).toEqual(["src/*.ts"]);
    expect(normalizeTransferPattern("/workspace", root)).toEqual(["**"]);
    expect(normalizeTransferPattern("/workspace/", "/workspace/")).toEqual(["**"]);
    expect(normalizeTransferPattern(".", root)).toEqual(["**"]);
    expect(normalizeTransferPattern("/etc/passwd", "/")).toEqual(["etc/passwd", "etc/passwd/**"]);
  });

  it("refuses empty patterns, paths outside the root, and ..", () => {
    expect(() => normalizeTransferPattern("  ", root)).toThrow(TypeError);
    expect(() => normalizeTransferPattern("/workspaces/x", root)).toThrow(RangeError);
    expect(() => normalizeTransferPattern("/etc", root)).toThrow(RangeError);
    expect(() => normalizeTransferPattern("a/../../b", root)).toThrow(RangeError);
  });
});

describe("splitPatternBase", () => {
  it("splits off the literal directories a glob starts in", () => {
    expect(splitPatternBase("src/**/*.ts")).toEqual({ base: "src", rest: "**/*.ts" });
    expect(splitPatternBase("**/*.ts")).toEqual({ base: "", rest: "**/*.ts" });
    expect(splitPatternBase("a/b/c.txt")).toEqual({ base: "a/b", rest: "c.txt" });
    expect(splitPatternBase("dist/**")).toEqual({ base: "dist", rest: "**" });
    expect(splitPatternBase("x")).toEqual({ base: "", rest: "x" });
  });
});
