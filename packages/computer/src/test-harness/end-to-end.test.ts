// End-to-end harness for @cloudflare/computer.
//
// Runs inside workerd via @cloudflare/vitest-pool-workers. The
// surrounding vitest config's globalSetup boots a computerd container
// on the host and writes its URL into the COMPUTERD_HARNESS_URL
// binding (or leaves it blank when docker isn't available).
//
// The test skips when the binding is empty so contributors
// without docker still see green; CI runs the full thing.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { withWorkspace } from "./with-workspace.js";

interface HarnessEnv {
  COMPUTERD_HARNESS_URL: string;
}

const url = (env as HarnessEnv).COMPUTERD_HARNESS_URL;
const describeIfDocker = url.length > 0 ? describe : describe.skip;

describeIfDocker("Workspace end-to-end against a real computerd container", () => {
  it("connects via TestBackend and round-trips a small file", async () => {
    await withWorkspace(url, async (ws) => {
      await ws.ready();
      await ws.fs.writeFile("/hello.txt", "hello workspace");
      expect(await ws.fs.readFile("/hello.txt", "utf8")).toBe("hello workspace");
    });
  });

  it("round-trips a multi-chunk file", async () => {
    await withWorkspace(url, async (ws) => {
      await ws.ready();
      const bytes = new Uint8Array(600 * 1024); // > CHUNK_SIZE (512 KiB)
      for (let i = 0; i < bytes.byteLength; i++) bytes[i] = i & 0xff;
      await ws.fs.writeFile("/big.bin", bytes);
      const back = new Uint8Array(
        await new Response(await ws.fs.readFile("/big.bin")).arrayBuffer(),
      );
      expect(back.byteLength).toBe(bytes.byteLength);
      // Spot-check three offsets rather than a full memcmp.
      expect(back[0]).toBe(bytes[0]);
      expect(back[300_000]).toBe(bytes[300_000]);
      expect(back[bytes.byteLength - 1]).toBe(bytes[bytes.byteLength - 1]);
    });
  });

  it("stat returns the documented shape; missing paths throw ENOENT", async () => {
    await withWorkspace(url, async (ws) => {
      await ws.ready();
      await ws.fs.writeFile("/probe.txt", "data");
      const entry = await ws.fs.stat("/probe.txt");
      expect(entry).toMatchObject({
        name: "probe.txt",
        size: 4,
        isFile: true,
        isDirectory: false,
      });
      await expect(ws.fs.stat("/missing")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(ws.fs.readFile("/missing")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
