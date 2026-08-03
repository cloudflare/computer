// Resolve the published @cloudflare/computer/shell/* subpaths to
// their source files for the test runners. shell-modules.ts
// imports the core group by subpath and a consumer imports the
// optional ones it wants; those subpaths resolve through the
// package's dist exports, which a src-based test run doesn't
// build. Point them at the generated src files instead.

import { resolve } from "node:path";

const src = resolve(import.meta.dirname, "..", "src", "backends", "worker-shell");

const groups = [
  "core",
  "curl",
  "html-to-markdown",
  "python",
  "sqlite",
  "js-exec",
  "yq",
  "file",
  "xan",
  "jq",
] as const;

export const shellModuleAliases = groups.map((group) => ({
  find: `@cloudflare/computer/shell/${group}`,
  replacement: resolve(src, "generated", `${group}.ts`),
}));
