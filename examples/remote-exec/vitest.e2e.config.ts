// The example end to end: test/setup.ts starts `wrangler dev`, with Docker for the container, and
// each test/*.test.ts drives a workspace of its own through the Worker's HTTP routes.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/setup.ts"],
    // A suite's first command builds or starts its container.
    testTimeout: 180_000,
    hookTimeout: 600_000,
  },
});
