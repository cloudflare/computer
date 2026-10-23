// Bundle @cloudflare/computer's source plus its internal deps
// (@cloudflare/dofs, @cloudflare/computer-rpc) into a single ESM
// artefact that downstream callers can install with no other
// @cloudflare/* dependencies.
//
// tsdown keeps `dependencies` and `peerDependencies` external and
// bundles everything else, so dofs and computer-rpc (devDependencies)
// are inlined while capnweb, ai, zod, just-bash, vite and
// @platformatic/vfs stay as imports.
//
// The git entrypoint bundles isomorphic-git, but aliases pako to a
// tiny node:zlib-backed compatibility layer so Workers don't carry
// pako's JavaScript zlib implementation, and sha.js's SHA-1 to a
// node:crypto one so they don't carry sha.js and the Buffer and
// typed-array polyfills behind it.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";

// Anchor the alias paths to this config file so the build works
// regardless of which directory it was started from.
const here = resolve(fileURLToPath(import.meta.url), "..");

export default defineConfig({
  entry: {
    index: "src/index.ts",
    git: "src/git/index.ts",
    "artifacts/index": "src/artifacts/index.ts",
    "assets/index": "src/assets/index.ts",
    "tools/index": "src/tools/index.ts",
    "tools/ai-sdk": "src/tools/ai-sdk/index.ts",
    "tools/core": "src/tools/core.ts",
    "tools/pi-ai": "src/tools/pi-ai/index.ts",
    "tools/tanstack-ai": "src/tools/tanstack-ai/index.ts",
    "modules/container": "src/modules/container.ts",
    "modules/git": "src/modules/git.ts",
    "modules/artifacts": "src/modules/artifacts.ts",
    "modules/tools": "src/modules/tools.ts",
    "modules/assets": "src/modules/assets.ts",
    "backends/container-legacy/index": "src/backends/container-legacy/index.ts",
    "backends/container/index": "src/backends/container/index.ts",
    "backends/worker-javascript/index": "src/backends/worker-javascript/index.ts",
    "backends/worker-shell/index": "src/backends/worker-shell/index.ts",
    // The shell-module groups build-bundle.mjs emits. Each is its
    // own entry so it lands at the dist path the ./shell/* package
    // exports point at; shell-modules.ts imports the core group by
    // subpath (kept external below) and a consumer imports the
    // optional ones it wants, so the bundler tree-shakes any group
    // that is never imported.
    "backends/worker-shell/shell/core": "src/backends/worker-shell/generated/core.ts",
    "backends/worker-shell/shell/curl": "src/backends/worker-shell/generated/curl.ts",
    "backends/worker-shell/shell/html-to-markdown":
      "src/backends/worker-shell/generated/html-to-markdown.ts",
    "backends/worker-shell/shell/python": "src/backends/worker-shell/generated/python.ts",
    "backends/worker-shell/shell/sqlite": "src/backends/worker-shell/generated/sqlite.ts",
    "backends/worker-shell/shell/js-exec": "src/backends/worker-shell/generated/js-exec.ts",
    "backends/worker-shell/shell/yq": "src/backends/worker-shell/generated/yq.ts",
    "backends/worker-shell/shell/file": "src/backends/worker-shell/generated/file.ts",
    "backends/worker-shell/shell/xan": "src/backends/worker-shell/generated/xan.ts",
    "backends/worker-shell/shell/jq": "src/backends/worker-shell/generated/jq.ts",
    "observe/cloudflare": "src/observe/cloudflare.ts",
    "vite/index": "src/vite/index.ts",
  },
  // The output runs in workerd, not Node. `browser` resolves bundled
  // dependencies the way wrangler does for Workers (browser/import
  // conditions, then `browser`/`module`/`main`); `node` would pick the
  // CJS builds that some packages, isomorphic-git among them, ship
  // under the `node` condition.
  platform: "browser",
  tsconfig: "tsconfig.build.json",
  deps: {
    neverBundle: [
      // Provided by the workerd runtime; `node:*` via nodejs_compat.
      "cloudflare:workers",
      /^node:/,
      // shell-modules.ts imports the generated groups by their
      // published subpath. Keep the specifiers intact in the emitted
      // bundle rather than inlining the group here so the consumer's
      // bundler sees each group as its own module and can drop one it
      // never imports; each group is built as its own entry above.
      /^@cloudflare\/computer\/shell\//,
    ],
    // Every third-party package that ends up inside dist/. Adding to
    // this list is a size decision, so the build fails rather than
    // quietly bundling something new.
    onlyBundle: [
      "acorn",
      "diff",
      "isomorphic-git",
      // isomorphic-git's own dependencies.
      "async-lock",
      "clean-git-ref",
      "crc-32",
      "diff3",
      "ignore",
      "pify",
    ],
  },
  alias: {
    "@cloudflare/dofs": resolve(here, "../dofs/src/index.ts"),
    "@cloudflare/dofs/testing": resolve(here, "../dofs/src/testing.ts"),
    "@cloudflare/computer-rpc": resolve(here, "../rpc/src/index.ts"),
    "@cloudflare/computer-rpc/driver": resolve(here, "../rpc/src/sync-driver.ts"),
    pako: resolve(here, "src/git/pako-zlib-shim.ts"),
    "sha.js/sha1.js": resolve(here, "src/git/sha1-crypto-shim.ts"),
  },
  // ESM only. Nothing in-tree loads CJS — the example Worker, computerd,
  // and tests are all ESM — and a published-as-alpha API doesn't
  // have any external CJS consumers to maintain back-compat for.
  format: "esm",
  // Keep `.js` / `.d.ts` to match the `exports` map; the package is
  // `"type": "module"`, so `.mjs` buys nothing.
  fixedExtension: false,
  sourcemap: true,
  // Declarations go through `tsc`: tsconfig doesn't enable
  // isolatedDeclarations, which the faster oxc emitter needs.
  dts: true,
  outputOptions: {
    // Code shared between entries is hoisted into separate chunks;
    // give them a self-explanatory name in the published tarball.
    chunkFileNames: "shared-[hash].js",
    codeSplitting: {
      groups: [
        // Rolldown parks its runtime helpers (`__exportAll`,
        // `__toESM`, ...) in whichever chunk it builds first. Left
        // alone they land in the lazily loaded isomorphic-git chunk,
        // and every chunk needing a helper then imports all of
        // isomorphic-git statically: `./tools` paid ~560K for a
        // 1K helper. A chunk of their own keeps that edge cheap.
        { name: "runtime", test: /rolldown[\\/]runtime/ },
      ],
    },
  },
});
