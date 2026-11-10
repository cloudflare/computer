/**
 * The builds a Worker carries: as imported bytes (bundledRemoteExec) and as files streamed with
 * node:fs (fileRemoteExec), which in a Worker are under /bundle.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundledRemoteExec, fileRemoteExec } from "./bundle";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("bundledRemoteExec", () => {
  it("names the architecture it has no build for", async () => {
    const binaries = bundledRemoteExec({ x86_64: new Uint8Array([1]).buffer as ArrayBuffer });
    expect(await binaries.sha256("x86_64")).toBe(sha256(new Uint8Array([1])));
    await expect(binaries.sha256("aarch64")).rejects.toThrow(
      /no remote-exec build for aarch64 \(it has x86_64\)/,
    );
  });
});

describe("fileRemoteExec", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "remote-exec-bundle-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Bigger than one read, and not a multiple of it.
  const build = () => {
    const bytes = new Uint8Array(200 * 1024 + 123);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    const path = join(dir, "remote-exec");
    writeFileSync(path, bytes);
    return { bytes, path };
  };

  it("streams the file a chunk at a time, and hashes it the same way", async () => {
    const { bytes, path } = build();
    const binaries = fileRemoteExec({ x86_64: path });
    const chunks: Uint8Array[] = [];
    for await (const chunk of await binaries.open("x86_64")) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((c) => c.byteLength))).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.concat(chunks).equals(Buffer.from(bytes))).toBe(true);
    expect(await binaries.sha256("x86_64")).toBe(sha256(bytes));
  });

  it("reads only as the stream is pulled, and stops when it's cancelled", async () => {
    const { path } = build();
    const stream = await fileRemoteExec({ x86_64: path }).open("x86_64");
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.value?.byteLength).toBe(64 * 1024);
    await reader.cancel();
    expect((await reader.read()).done).toBe(true);
  });

  it("names a missing architecture, and retries a file that wasn't there yet", async () => {
    const path = join(dir, "remote-exec");
    const binaries = fileRemoteExec({ x86_64: path });
    await expect(binaries.sha256("aarch64")).rejects.toThrow(/no remote-exec build for aarch64/);
    await expect(binaries.sha256("x86_64")).rejects.toThrow(/ENOENT/);
    writeFileSync(path, "now it is");
    expect(await binaries.sha256("x86_64")).toBe(sha256(new TextEncoder().encode("now it is")));
  });
});
