// Docker harness for the computer package.
//
// The package runs inside a Cloudflare Worker / Durable
// Object; this config drives it through workerd via
// @cloudflare/vitest-pool-workers. The computerd container itself
// is booted by test-harness/run-harness.sh (a shell wrapper
// that owns the docker lifecycle), which exports
// COMPUTERD_HARNESS_URL into the environment before invoking vitest.
//
// Why a wrapper instead of globalSetup: vitest reads the
// `miniflare.bindings` map at config-load time, before any
// globalSetup hook fires. Setting process.env inside
// globalSetup is too late to flow into the worker's bindings.
// The wrapper sets the URL upfront so this config can read it
// during normal evaluation.

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test-harness/wrangler.jsonc" },
      // Forward the URL globalSetup wrote into process.env
      // through to the worker's `env` binding.
      miniflare: {
        bindings: {
          COMPUTERD_HARNESS_URL: process.env.COMPUTERD_HARNESS_URL ?? "",
        },
      },
    }),
  ],
  test: {
    globals: true,
    include: ["src/test-harness/*.test.ts"],

    // The harness test boots a Docker container and runs an
    // end-to-end RPC round trip; default 5s vitest timeout is
    // tight for image pulls + cold starts.
    testTimeout: 60_000,
  },
});
