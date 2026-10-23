import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    server: "src/server.ts",
    client: "src/client.ts",
    "sync-driver": "src/sync-driver.ts",
    debug: "src/debug.ts",
  },
  // Consumed from dist only by computerd (Node). @cloudflare/computer
  // bundles from source, so this build never reaches workerd as-is.
  platform: "node",
  tsconfig: "tsconfig.build.json",
  // Keep `.js` / `.d.ts` to match the `exports` map; the package is
  // `"type": "module"`, so `.mjs` buys nothing.
  fixedExtension: false,
  sourcemap: true,
  dts: true,
});
