// workerBundle: a Vite plugin that ships a directory into a Worker's
// upload so WorkerBundle() can read it from /bundle.
//
// @cloudflare/vite-plugin ignores `find_additional_modules` and `rules`
// in wrangler.jsonc, and the wrangler.json it generates for deploy sets
// `no_bundle: true` with an ESModule-only rule. Wrangler then uploads
// the output directory's JavaScript plus files matching its default
// rules (.txt, .html, .sql, .bin, .wasm), so anything else in the
// output never reaches the Worker. This plugin closes that gap: it
// emits the directory into the Worker's output with its paths intact,
// and adds a Data rule for it to the generated wrangler.json. Both
// `vite preview` and `wrangler deploy` read that file.
//
// Runs at build time only. `vite dev` serves the Worker through Vite's
// module runner and never populates /bundle, so there is nothing for
// the plugin to do there; WorkerBundle() reports that case itself.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { Plugin } from "vite";

export interface WorkerBundlePluginOptions {
  // Directory to ship, relative to the Vite root.
  dir: string;
  // Path under /bundle. Defaults to the last segment of `dir`, so
  // "src/templates" matches WorkerBundle("templates").
  as?: string;
  // Vite environment to apply to. Defaults to every Worker environment
  // the Cloudflare plugin builds.
  environment?: string;
}

// The slices of wrangler's config shape this plugin reads and writes.
interface Rule {
  type: string;
  globs: string[];
  fallthrough?: boolean;
}

interface OutputWorkerConfig {
  rules?: Rule[];
  [key: string]: unknown;
}

const WRANGLER_JSON = "wrangler.json";

export function workerBundle(options: WorkerBundlePluginOptions): Plugin {
  const as = normalizeAs(options.as ?? lastSegment(options.dir));
  const glob = `${as}/**/*`;
  let sourceDir = "";

  return {
    name: "@cloudflare/computer:worker-bundle",
    apply: "build",
    configResolved(config) {
      sourceDir = resolve(config.root, options.dir);
    },
    buildStart() {
      // The client environment builds browser assets, never a Worker.
      if (this.environment.name === "client") return;
      if (!isDirectory(sourceDir)) {
        this.error(`workerBundle: ${sourceDir} does not exist or is not a directory`);
      }
      for (const file of listFiles(sourceDir)) this.addWatchFile(file);
    },
    // The Cloudflare plugin emits wrangler.json as an asset from its own
    // generateBundle hook. Running after it ("post") lets us edit that
    // asset in memory instead of rewriting the file once it is on disk,
    // and its presence tells us which environments are Workers.
    generateBundle: {
      order: "post",
      handler(_outputOptions, bundle) {
        const environment = this.environment.name;
        if (environment === "client") return;
        if (options.environment !== undefined && options.environment !== environment) return;

        const asset = bundle[WRANGLER_JSON];
        if (asset === undefined || asset.type !== "asset") {
          if (options.environment !== undefined) {
            this.error(
              `workerBundle: environment "${environment}" did not produce a ${WRANGLER_JSON}. ` +
                "Is it a Worker built by @cloudflare/vite-plugin?",
            );
          }
          return;
        }

        const source =
          typeof asset.source === "string" ? asset.source : new TextDecoder().decode(asset.source);
        const config = JSON.parse(source) as OutputWorkerConfig;
        config.rules = withDataRule(config.rules ?? [], glob);
        asset.source = JSON.stringify(config);

        for (const file of listFiles(sourceDir)) {
          const rel = relative(sourceDir, file).split(sep).join("/");
          this.emitFile({ type: "asset", fileName: `${as}/${rel}`, source: readFileSync(file) });
        }
      },
    },
  };
}

// Added with fallthrough, because without it wrangler drops every later
// rule of the same type, its default .bin rule among them, and .bin
// imports elsewhere in the Worker would stop resolving. The cost is a
// harmless "Ignoring duplicate module" warning for bundled .bin files,
// which match both rules. Skipped when already present so two plugin
// instances for one directory add one rule.
function withDataRule(rules: Rule[], glob: string): Rule[] {
  const exists = rules.some((rule) => rule.type === "Data" && rule.globs.includes(glob));
  if (exists) return rules;
  return [{ type: "Data", globs: [glob], fallthrough: true }, ...rules];
}

function lastSegment(dir: string): string {
  const segments = dir.split(/[\\/]/).filter((s) => s.length > 0 && s !== ".");
  const last = segments.at(-1);
  if (last === undefined || last === "..") {
    throw new Error(
      `workerBundle: cannot derive a name from dir ${JSON.stringify(dir)}; pass \`as\``,
    );
  }
  return last;
}

function normalizeAs(as: string): string {
  const segments = as.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0) {
    throw new Error(`workerBundle: \`as\` must not be empty`);
  }
  if (segments.includes("..")) {
    throw new Error(`workerBundle: \`as\` must not contain '..' segments: ${JSON.stringify(as)}`);
  }
  return segments.join("/");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}
