// Bundle computerd into a single ESM file for Node's native SEA.
//
// Strategy:
//   * esbuild produces an ESM bundle of `dist/cli/computerd.cjs`. ESM is required so
//     capnweb's top-level await survives without an async-IIFE wrapper. A banner
//     re-establishes `require`, `__filename`, and `__dirname` for any CJS code
//     transpiled into the bundle.
//   * fuse-native's `require('node-gyp-build')(__dirname)` call is intercepted
//     by an esbuild plugin. The shim resolves the .node addon and libfuse
//     shared library from SEA assets at runtime (via `node:sea`), writes them
//     to a deterministic temp directory keyed by sha256, and dlopens the
//     addon. The shared library is found by the dynamic loader via
//     LD_LIBRARY_PATH / DYLD_LIBRARY_PATH, prepended in the same shim.
//   * `fuse-shared-library` is also intercepted: in the deployed environment
//     the host already provides `fusermount`, so configure/isConfigured are
//     no-ops. The lib path field is left empty because nothing inside
//     fuse-native reads it directly.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const computerdRoot = resolve(here, "../..");
const repoRoot = resolve(computerdRoot, "../..");

export async function bundleComputerd({ outfile, target }) {
  const nodeGypBuildShim = `
const { writeFileSync, chmodSync, existsSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const sea = require("node:sea");

const LIBFUSE_NAME = ${JSON.stringify(target.libfuseName)};
const ENV_VAR = ${JSON.stringify(target.envVar)};

let cached;
function loadNative() {
	if (cached) return cached;
	const addonBuf = Buffer.from(sea.getAsset("fuse-native.node"));
	const libBuf = Buffer.from(sea.getAsset(LIBFUSE_NAME));
	const hash = createHash("sha256").update(addonBuf).update(libBuf).digest("hex").slice(0, 16);
	const dir = join(tmpdir(), "computerd-sea-" + hash);
	try { mkdirSync(dir, { recursive: true }); } catch {}
	const libPath = join(dir, LIBFUSE_NAME);
	const addonPath = join(dir, "fuse-native.node");
	if (!existsSync(libPath)) writeFileSync(libPath, libBuf);
	if (!existsSync(addonPath)) { writeFileSync(addonPath, addonBuf); chmodSync(addonPath, 0o755); }
	process.env[ENV_VAR] = dir + (process.env[ENV_VAR] ? ":" + process.env[ENV_VAR] : "");
	const m = { exports: {} };
	process.dlopen(m, addonPath);
	cached = m.exports;
	return cached;
}

module.exports = function nodeGypBuild(_dir) { return loadNative(); };
`;

  const fuseSharedLibraryShim = `
function noop(cb) { if (typeof cb === "function") process.nextTick(cb); }
function isConfigured(cb) { process.nextTick(() => cb(null, true)); }
module.exports = { beforeMount: noop, beforeUnmount: noop, configure: noop, unconfigure: noop, isConfigured };
`;

  const nativeShimPlugin = {
    name: "fuse-native-shim",
    setup(b) {
      b.onResolve({ filter: /^node-gyp-build$/ }, () => ({
        path: "node-gyp-build",
        namespace: "computerd-shim",
      }));
      b.onResolve({ filter: /^fuse-shared-library$/ }, () => ({
        path: "fuse-shared-library",
        namespace: "computerd-shim",
      }));
      b.onLoad({ filter: /.*/, namespace: "computerd-shim" }, (args) => {
        if (args.path === "node-gyp-build") {
          return { contents: nodeGypBuildShim, loader: "js", resolveDir: repoRoot };
        }
        if (args.path === "fuse-shared-library") {
          return { contents: fuseSharedLibraryShim, loader: "js" };
        }
        return null;
      });
    },
  };

  // COMPUTERD_DEFAULT_PORT lets a build pipeline stamp the compiled-in
  // port without editing source. Runtime PORT env still wins.
  const buildPortEnv = process.env.COMPUTERD_DEFAULT_PORT;
  const buildPort =
    buildPortEnv === undefined || buildPortEnv === "" ? undefined : Number(buildPortEnv);
  if (
    buildPort !== undefined &&
    (!Number.isInteger(buildPort) || buildPort < 0 || buildPort > 65_535)
  ) {
    throw new Error(
      `COMPUTERD_DEFAULT_PORT must be an integer between 0 and 65535, got ${JSON.stringify(buildPortEnv)}`,
    );
  }

  await build({
    entryPoints: [resolve(computerdRoot, "dist/cli/computerd.cjs")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    define: {
      __COMPUTERD_BUILD_DEFAULT_PORT__: buildPort === undefined ? "undefined" : String(buildPort),
    },
    // computerd is compiled to CJS, so esbuild walks it via the `require`
    // condition. Add `import` to that list so dofs and computer-rpc
    // (ESM-only after the SEA migration) still resolve via their exports map.
    conditions: ["import", "node"],
    outfile,
    banner: {
      js: [
        "import { createRequire as __cr } from 'node:module';",
        "import { dirname as __dn } from 'node:path';",
        // When running inside SEA the module url is a data: URL, which",
        // createRequire rejects. Use process.execPath so require can resolve",
        // builtins and __dirname points at the directory holding the binary.",
        "const __filename = process.execPath;",
        "const __dirname = __dn(__filename);",
        "const require = __cr(__filename);",
      ].join(""),
    },
    plugins: [nativeShimPlugin],
    logLevel: "warning",
  });
}
