import type { JsProgramCtx } from "@cloudflare/kitebuild-runtime";
import { describe, expect, it, vi } from "vitest";

import { readAll } from "./fd-io";

// The package's main entry needs the Workers runtime, and readAll uses
// none of it.
vi.mock("@cloudflare/kitebuild-runtime", () => ({ writeFdBytes: () => -1 }));

// A program context whose descriptor 0 reads `bytes` as a redirected file,
// counting the bytes its body copies.
function withStdin(bytes: Uint8Array) {
  const copied = { bytes: 0 };
  const body = {
    size: bytes.length,
    readInto(target: Uint8Array, offset: number) {
      const read = Math.min(target.length, Math.max(0, bytes.length - offset));
      target.set(bytes.subarray(offset, offset + read));
      copied.bytes += read;
      return read;
    },
    snapshot() {
      copied.bytes += bytes.length;
      return bytes.slice();
    },
  };
  const entry = { node: { type: "reg", body }, offset: 0 };
  const ctx = {
    proc: { fdt: { get: (fd: number) => (fd === 0 ? entry : null) } },
    signal: new AbortController().signal,
  } as unknown as JsProgramCtx;
  return { ctx, copied };
}

describe("readAll", () => {
  it("copies each byte of a redirected file once", async () => {
    const text = "x".repeat(1024 * 1024);
    const { ctx, copied } = withStdin(new TextEncoder().encode(text));
    expect(await readAll(ctx, 0)).toBe(text);
    expect(copied.bytes).toBe(text.length);
  });
});
