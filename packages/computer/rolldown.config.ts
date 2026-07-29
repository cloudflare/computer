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
// `node:*` builtins are externalised automatically because
// `platform: "node"` is the default for `esm` output here.

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
    "backends/worker/index": "src/backends/worker/index.ts",
    "observe/cloudflare": "src/observe/cloudflare.ts",
  },
  external: [
    "cloudflare:workers",
    "capnweb",
    "@platformatic/vfs",
    "ai",
    "zod",
    "isomorphic-git",
    /^isomorphic-git\//,
    "just-bash",
    "node:crypto",
    "node:events",
  ],
  resolve: {
    alias: {
      "@cloudflare/dofs": resolve(here, "../dofs/src/index.ts"),
      "@cloudflare/dofs/testing": resolve(here, "../dofs/src/testing.ts"),
      "@cloudflare/computer-rpc": resolve(here, "../rpc/src/index.ts"),
      "@cloudflare/computer-rpc/driver": resolve(here, "../rpc/src/sync-driver.ts"),
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
