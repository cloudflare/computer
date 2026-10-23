import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "node-storage": "src/node-storage.ts",
    testing: "src/testing.ts",
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
