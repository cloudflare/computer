import { defineConfig } from "tsdown";

export default defineConfig({
  // `cli/computerd` lands at dist/cli/computerd.js, the `bin` path.
  // build:bin bundles that file again with esbuild for the SEA binary.
  entry: { "cli/computerd": "src/cli/computerd.ts" },
  platform: "node",
  // Keep `.js` for the `bin`; the package is `"type": "module"`, so
  // `.mjs` buys nothing. The target comes from `engines.node`.
  fixedExtension: false,
  sourcemap: true,
});
