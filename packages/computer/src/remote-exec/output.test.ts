import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncFs } from "./fs";
import { OutputCapture, outputSettings } from "./output";
import { directoryFs } from "./testing/local";

let ws: string;
let fs: SyncFs;
beforeEach(async () => {
  ws = await fsp.mkdtemp(path.join(os.tmpdir(), "remote-exec-output-"));
  fs = directoryFs(ws);
});
afterEach(async () => {
  await fsp.rm(ws, { recursive: true, force: true });
});

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const stream = (...chunks: string[]) => new Blob(chunks).stream();
const lines = (n: number) => `${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

describe("outputSettings", () => {
  it("defaults to computer's: 2000 lines, 64 KiB, /.computer/output, keep 50", () => {
    expect(outputSettings(undefined)).toEqual({
      maxLines: 2000,
      maxBytes: 65536,
      dir: "/.computer/output",
      keep: 50,
    });
    expect(outputSettings({ maxLines: 5, dir: "/x" })).toEqual({
      maxLines: 5,
      maxBytes: 65536,
      dir: "/x",
      keep: 50,
    });
    expect(outputSettings(false).dir).toBeUndefined();
  });
});

describe("OutputCapture", () => {
  it("keeps everything within the limits and saves nothing", async () => {
    const capture = new OutputCapture(
      fs,
      outputSettings({ maxLines: 3, maxBytes: 100, dir: "/workspace/out" }),
      "a.stdout.log",
    );
    const { kept, truncated } = await capture.consume(stream("a\n", "b\n", "c\n"));
    expect(text(kept)).toBe("a\nb\nc\n");
    expect(truncated).toBeUndefined();
    await expect(fsp.stat(path.join(ws, "out"))).rejects.toThrow(/ENOENT/);
  });

  it("is exactly at the limits without being truncated", async () => {
    const capture = new OutputCapture(
      fs,
      outputSettings({ maxLines: 2, maxBytes: 4, dir: "/workspace/out" }),
      "b.stdout.log",
    );
    expect((await capture.consume(stream("a\nb\n"))).truncated).toBeUndefined();
  });

  it("counts a last line without a newline", async () => {
    const capture = new OutputCapture(
      fs,
      outputSettings({ maxLines: 2, maxBytes: 100, dir: "/workspace/out" }),
      "c.stdout.log",
    );
    const { truncated, kept } = await capture.consume(stream("1\n2\n3"));
    expect(text(kept)).toBe("2\n3");
    expect(truncated).toMatchObject({
      status: "saved",
      totalLines: 3,
      firstLine: 2,
      partialLine: false,
      totalBytes: 5,
    });
  });

  it("keeps the last lines and saves all of it when the line limit is passed", async () => {
    const all = lines(50);
    const capture = new OutputCapture(
      fs,
      outputSettings({ maxLines: 3, maxBytes: 1000, dir: "/workspace/out" }),
      "d.stdout.log",
    );
    const { kept, truncated } = await capture.consume(stream(all.slice(0, 100), all.slice(100)));
    expect(text(kept)).toBe("line 48\nline 49\nline 50\n");
    expect(truncated).toEqual({
      status: "saved",
      path: "/workspace/out/d.stdout.log",
      totalBytes: all.length,
      totalLines: 50,
      firstLine: 48,
      partialLine: false,
    });
    expect(await fsp.readFile(path.join(ws, "out/d.stdout.log"), "utf8")).toBe(all);
  });

  it("cuts mid-line when the byte limit is passed, and says so", async () => {
    const capture = new OutputCapture(
      fs,
      outputSettings({ maxLines: 1000, maxBytes: 10, dir: "/workspace/out" }),
      "e.stdout.log",
    );
    const { kept, truncated } = await capture.consume(stream("aaaaaaaaaa\nbbbbbbbbbb\ncccc\n"));
    expect(text(kept)).toBe("bbbbb\ncccc\n".slice(-10));
    expect(truncated).toMatchObject({
      status: "saved",
      totalLines: 3,
      partialLine: true,
      totalBytes: 27,
    });
  });

  it("starts on a line boundary when the byte cut lands on one", async () => {
    const capture = new OutputCapture(
      fs,
      outputSettings({ maxLines: 1000, maxBytes: 5, dir: "/workspace/out" }),
      "f.stdout.log",
    );
    const { kept, truncated } = await capture.consume(stream("xxxxxxxx\n", "abcd\n"));
    expect(text(kept)).toBe("abcd\n");
    expect(truncated).toMatchObject({ partialLine: false, firstLine: 2 });
  });

  it("handles many small chunks and one huge chunk the same way", async () => {
    const all = lines(5000);
    const small = new OutputCapture(
      fs,
      outputSettings({ maxLines: 10, maxBytes: 1 << 20, dir: "/workspace/out" }),
      "g.stdout.log",
    );
    const big = new OutputCapture(
      fs,
      outputSettings({ maxLines: 10, maxBytes: 1 << 20, dir: "/workspace/out" }),
      "h.stdout.log",
    );
    const pieces = all.match(/[\s\S]{1,7}/g) ?? [];
    const a = await small.consume(stream(...pieces));
    const b = await big.consume(stream(all));
    expect(text(a.kept)).toBe(text(b.kept));
    expect(a.truncated).toMatchObject({ totalLines: 5000, firstLine: 4991 });
    expect(await fsp.readFile(path.join(ws, "out/g.stdout.log"), "utf8")).toBe(all);
  });

  it("reports not-saved when saving is off", async () => {
    const capture = new OutputCapture(fs, outputSettings(false), "i.stdout.log");
    const { kept, truncated } = await capture.consume(stream(lines(3000)));
    expect(text(kept).split("\n").length - 1).toBe(2000);
    expect(truncated).toMatchObject({
      status: "not-saved",
      reason: "saving output is turned off",
      totalLines: 3000,
    });
  });

  it("reports not-saved with the reason when the file can't be written", async () => {
    const broken: SyncFs = { ...fs, writeFile: async () => Promise.reject(new Error("disk full")) };
    const capture = new OutputCapture(
      broken,
      outputSettings({ maxLines: 1, dir: "/workspace/out" }),
      "j.stdout.log",
    );
    const { kept, truncated } = await capture.consume(stream("a\nb\nc\n"));
    expect(text(kept)).toBe("c\n");
    expect(truncated).toMatchObject({ status: "not-saved", reason: "disk full" });
  });

  it("keeps only the newest `keep` saved files, sharing them with computer's", async () => {
    const settings = outputSettings({ maxLines: 1, dir: "/workspace/out", keep: 3 });
    await fsp.mkdir(path.join(ws, "out"));
    // Older files, including one of computer's own and one that isn't output at all.
    for (const [i, name] of [
      "old1.stdout.log",
      "computer.stderr.log",
      "old2.stdout.log",
      "notes.txt",
    ].entries()) {
      await fsp.writeFile(path.join(ws, "out", name), "x");
      const t = new Date(Date.now() - (10 - i) * 1000);
      await fsp.utimes(path.join(ws, "out", name), t, t);
    }
    await new OutputCapture(fs, settings, "new.stdout.log").consume(stream("a\nb\n"));
    expect((await fsp.readdir(path.join(ws, "out"))).sort()).toEqual([
      "computer.stderr.log",
      "new.stdout.log",
      "notes.txt",
      "old2.stdout.log",
    ]);
  });

  it("captures an empty stream", async () => {
    const { kept, truncated } = await new OutputCapture(
      fs,
      outputSettings(undefined),
      "k.stdout.log",
    ).consume(stream());
    expect(kept.byteLength).toBe(0);
    expect(truncated).toBeUndefined();
  });
});
