import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Workerd-backed runner. Same .test.ts files as the node project, but
// withDB resolves to the Durable Object-backed implementation via the
// alias below.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.jsonc" },
    }),
  ],
  resolve: {
    // Match any relative import that lands on src/fs/with-db.js so
    // tests under src/fs/, src/, and src/sync/ all resolve to the
    // workerd-backed implementation regardless of their depth.
    alias: [
      {
        find: /^.*\/with-db\.js$/,
        replacement: new URL("./src/fs/with-db.workers.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // These files exercise SQLiteTestStorage directly. The
    // node:sqlite-backed fixture has no analogue under workerd and
    // importing it crashes the pool worker instead of reporting a
    // module-resolution error. schema/index.test.ts also stages raw,
    // pre-migration databases, which withDB cannot represent.
    // All other tests run under both backends; helpers delegate to
    // withDB, which this config aliases to a DO-backed implementation.
    exclude: ["src/schema/index.test.ts", "src/testing.test.ts"],
  },
});
