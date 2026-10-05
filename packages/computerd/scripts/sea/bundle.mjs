// Bundle computerd into a single ESM file for Node's native SEA.
//
// Strategy:
//   * esbuild produces an ESM bundle of `dist/cli/computerd.cjs`. ESM is required so
//     capnweb's top-level await survives without an async-IIFE wrapper. A banner
//     re-establishes `require`, `__filename`, and `__dirname` for any CJS code
//     transpiled into the bundle.
//   * fuse-napi loads its addon through `require('node-gyp-build')(root)`. An
//     esbuild plugin replaces that module with a shim that reads the addon
//     from the SEA assets (via `node:sea`), writes it to a temp directory
//     keyed by its sha256, and dlopens it. The addon links the system
//     libfuse 3, which the dynamic loader finds on its default path.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const computerdRoot = resolve(here, "../..");
const repoRoot = resolve(computerdRoot, "../..");

export async function bundleComputerd({ outfile }) {
  const nodeGypBuildShim = `
const { writeFileSync, chmodSync, existsSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const sea = require("node:sea");

let cached;
function loadNative() {
	if (cached) return cached;
	const addonBuf = Buffer.from(sea.getAsset("fuse.node"));
	const hash = createHash("sha256").update(addonBuf).digest("hex").slice(0, 16);
	const dir = join(tmpdir(), "computerd-sea-" + hash);
	try { mkdirSync(dir, { recursive: true }); } catch {}
	const addonPath = join(dir, "fuse.node");
	if (!existsSync(addonPath)) { writeFileSync(addonPath, addonBuf); chmodSync(addonPath, 0o755); }
	const m = { exports: {} };
	try {
		process.dlopen(m, addonPath);
	} catch (error) {
		if (typeof error?.message === "string" && error.message.includes("libfuse3")) {
			const wrapped = new Error(
				"computerd needs libfuse 3.17 or newer. On Debian trixie or later, " +
				"install it with: apt-get install fuse3",
			);
			wrapped.code = "EFUSEDEPENDENCY";
			wrapped.cause = error;
			throw wrapped;
		}
		throw error;
	}
	cached = m.exports;
	return cached;
}

module.exports = function nodeGypBuild(_dir) { return loadNative(); };
`;

  const nativeShimPlugin = {
    name: "fuse-napi-shim",
    setup(b) {
      b.onResolve({ filter: /^node-gyp-build$/ }, () => ({
        path: "node-gyp-build",
        namespace: "computerd-shim",
      }));
      b.onLoad({ filter: /.*/, namespace: "computerd-shim" }, () => ({
        contents: nodeGypBuildShim,
        loader: "js",
        resolveDir: repoRoot,
      }));
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
