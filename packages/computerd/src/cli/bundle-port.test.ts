import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, onTestFinished, test } from "vitest";

// Confirm COMPUTERD_DEFAULT_PORT on the build host stamps into the bundled
// source so downstream builds can fix a custom default without
// patching source. The bundle script is exercised directly; the
// runtime PORT env still wins (covered separately by the CLI
// integration tests).

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(here, "../../dist/cli/computerd.cjs");
const bundleScript = path.resolve(here, "../../scripts/sea/bundle.mjs");

type BundleComputerd = (opts: {
  outfile: string;
  target: { libfuseName: string; envVar: string };
}) => Promise<void>;

async function loadBundler(ctx: {
  skip: (reason?: string) => void;
}): Promise<BundleComputerd | undefined> {
  try {
    await fs.access(distEntry);
  } catch {
    ctx.skip("dist/cli/computerd.cjs not built; run `npm run build` first");
    return undefined;
  }
  const mod = (await import(bundleScript)) as { bundleComputerd: BundleComputerd };
  return mod.bundleComputerd;
}

test("COMPUTERD_DEFAULT_PORT stamps into the SEA bundle", async (ctx) => {
  const bundleComputerd = await loadBundler(ctx);
  if (bundleComputerd === undefined) return;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-bundle-"));
  onTestFinished(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    delete process.env.COMPUTERD_DEFAULT_PORT;
  });
  const outfile = path.join(tmp, "computerd.bundle.mjs");
  process.env.COMPUTERD_DEFAULT_PORT = "12345";

  await bundleComputerd({
    outfile,
    target: { libfuseName: "libfuse.so.2", envVar: "LD_LIBRARY_PATH" },
  });

  const bundle = await fs.readFile(outfile, "utf8");
  // esbuild's `define` produces `const DEFAULT_PORT = 12345 ?? 45678;`
  // (or similar). Either way, the literal 12345 should appear.
  expect(bundle).toMatch(/12345/);
});

test("missing COMPUTERD_DEFAULT_PORT keeps the in-source 45678 fallback", async (ctx) => {
  const bundleComputerd = await loadBundler(ctx);
  if (bundleComputerd === undefined) return;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-bundle-"));
  onTestFinished(async () => fs.rm(tmp, { recursive: true, force: true }));
  const outfile = path.join(tmp, "computerd.bundle.mjs");
  delete process.env.COMPUTERD_DEFAULT_PORT;

  await bundleComputerd({
    outfile,
    target: { libfuseName: "libfuse.so.2", envVar: "LD_LIBRARY_PATH" },
  });

  const bundle = await fs.readFile(outfile, "utf8");
  // Fallback literal must survive substitution.
  expect(bundle).toMatch(/45678/);
});

test("COMPUTERD_DEFAULT_PORT rejects non-integer values", async (ctx) => {
  const bundleComputerd = await loadBundler(ctx);
  if (bundleComputerd === undefined) return;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-bundle-"));
  onTestFinished(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    delete process.env.COMPUTERD_DEFAULT_PORT;
  });
  process.env.COMPUTERD_DEFAULT_PORT = "not-a-port";

  await expect(
    bundleComputerd({
      outfile: path.join(tmp, "computerd.bundle.mjs"),
      target: { libfuseName: "libfuse.so.2", envVar: "LD_LIBRARY_PATH" },
    }),
  ).rejects.toThrow(/COMPUTERD_DEFAULT_PORT/);
});
