// End-to-end load characterisation against a real computerd
// container. Runs via 'npm run bench:harness' which wraps
// the same docker bootstrap used by the regression test
// suite. The package code runs inside workerd; the wire
// traverses miniflare → host port → docker → computerd.
//
// Skips when the harness URL isn't set (docker not
// available); contributors without docker still see the
// benchmark file pass.

import { env } from "cloudflare:test";
import { bench, describe } from "vitest";

import { withWorkspace } from "./with-workspace.js";

interface HarnessEnv {
  COMPUTERD_HARNESS_URL: string;
}

const url = (env as HarnessEnv).COMPUTERD_HARNESS_URL;
const describeIfDocker = url.length > 0 ? describe : describe.skip;

// Each bench iteration mints its own Workspace so leftover
// state doesn't bias subsequent runs. The connect() cost is
// the WebSocket upgrade + /health probe; we report it
// alongside the operation under test.

describeIfDocker("end-to-end — small file round-trip", () => {
  bench(
    "writeFile + readFile (16 bytes)",
    async () => {
      await withWorkspace(url, async (ws) => {
        await ws.ready();
        await ws.fs.writeFile("/probe.txt", "abcdefghijklmnop");
        await ws.fs.readFile("/probe.txt", "utf8");
      });
    },
    { iterations: 20 },
  );

  bench(
    "writeFile + readFile (1 MiB, single chunk under CHUNK_SIZE)",
    async () => {
      await withWorkspace(url, async (ws) => {
        await ws.ready();
        const bytes = new Uint8Array(1024 * 1024);
        for (let i = 0; i < bytes.byteLength; i += 4096) bytes[i] = (i * 31) & 0xff;
        await ws.fs.writeFile("/probe.bin", bytes);
        await ws.fs.readFile("/probe.bin");
      });
    },
    { iterations: 10 },
  );
});

describeIfDocker("end-to-end — multi-chunk file", () => {
  bench(
    "writeFile + readFile (4 MiB, 8 chunks)",
    async () => {
      await withWorkspace(url, async (ws) => {
        await ws.ready();
        const bytes = new Uint8Array(4 * 1024 * 1024);
        for (let i = 0; i < bytes.byteLength; i += 4096) bytes[i] = (i * 31) & 0xff;
        await ws.fs.writeFile("/big.bin", bytes);
        await ws.fs.readFile("/big.bin");
      });
    },
    { iterations: 5 },
  );

  bench(
    "writeFile only (4 MiB, 8 chunks) — push-side cost",
    async () => {
      await withWorkspace(url, async (ws) => {
        await ws.ready();
        const bytes = new Uint8Array(4 * 1024 * 1024);
        for (let i = 0; i < bytes.byteLength; i += 4096) bytes[i] = (i * 31) & 0xff;
        await ws.fs.writeFile("/write-only.bin", bytes);
      });
    },
    { iterations: 5 },
  );
});

describeIfDocker("end-to-end — burst writes", () => {
  bench(
    "100 small writes (sequential, distinct paths)",
    async () => {
      await withWorkspace(url, async (ws) => {
        await ws.ready();
        for (let i = 0; i < 100; i++) {
          await ws.fs.writeFile(`/burst_${i}.txt`, `iteration ${i}`);
        }
      });
    },
    { iterations: 5 },
  );
});
