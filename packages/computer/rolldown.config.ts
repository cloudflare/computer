// Bundle @cloudflare/computer's source plus its internal deps
// (@cloudflare/dofs, @cloudflare/computer-rpc) into a single ESM
// artefact that downstream callers can install with no other
// @cloudflare/* dependencies.
//
// Externals:
//   - cloudflare:workers — provided by the workerd runtime.
//   - capnweb            — a regular npm dep on this package.
//   - @platformatic/vfs  — optional userland import used by
//                          examples but not the workspace core.
//   - node:*             — provided by nodejs_compat in workerd.
//
// The git entrypoint bundles isomorphic-git, but aliases pako to a
// tiny node:zlib-backed compatibility layer so Workers don't carry
// pako's JavaScript zlib implementation.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "rolldown";
import { dts } from "rolldown-plugin-dts";

// Anchor the alias paths to this config file so `npx rolldown -c`
// works regardless of which directory the user ran it from.
const here = resolve(fileURLToPath(import.meta.url), "..");

export default defineConfig({
  input: {
    index: "src/index.ts",
    git: "src/git/index.ts",
    "artifacts/index": "src/artifacts/index.ts",
    "assets/index": "src/assets/index.ts",
    "tools/index": "src/tools/index.ts",
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
  },
  external: [
    "cloudflare:workers",
    "capnweb",
    "@platformatic/vfs",
    "ai",
    "zod",
    "just-bash",
    /^node:/,
    // shell-modules.ts imports the generated groups by their
    // published subpath. Keep the specifiers intact in the emitted
    // bundle rather than inlining the group here so the consumer's
    // bundler sees each group as its own module and can drop one it
    // never imports; each group is built as its own entry above.
    /^@cloudflare\/computer\/shell\//,
  ],
  resolve: {
    alias: {
      "@cloudflare/dofs": resolve(here, "../dofs/src/index.ts"),
      "@cloudflare/dofs/testing": resolve(here, "../dofs/src/testing.ts"),
      "@cloudflare/computer-rpc": resolve(here, "../rpc/src/index.ts"),
      "@cloudflare/computer-rpc/driver": resolve(here, "../rpc/src/sync-driver.ts"),
      pako: resolve(here, "src/git/pako-zlib-shim.ts"),
    },
  },
  // ESM only. Nothing in-tree loads CJS — the example Worker, computerd,
  // and tests are all ESM — and a published-as-alpha API doesn't
  // have any external CJS consumers to maintain back-compat for.
  output: {
    dir: "dist",
    format: "esm",
    sourcemap: true,
    // Rolldown hoists code shared between `index` and `git` into a
    // separate chunk. Default name is `libesm-<hash>.js`; rename to
    // something self-explanatory in the published tarball.
    chunkFileNames: "shared-[hash].js",
  },
  plugins: [
    dts({
      tsconfig: "tsconfig.build.json",
      // The dofs source uses constructs that oxc's isolated-
      // declarations emitter can't infer types for (private class
      // fields, generic dispatch tables, etc.), so use plain `tsc`
      // for the dts pass.
      oxc: false,
    }),
  ],
});
