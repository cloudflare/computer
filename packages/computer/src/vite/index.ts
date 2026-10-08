import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { Plugin } from "vite";

export interface WorkerBundlePluginOptions {
  dir: string;
  as?: string;
  environment?: string;
}

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
      if (this.environment.name === "client") return;
      if (!isDirectory(sourceDir)) {
        this.error(`workerBundle: ${sourceDir} does not exist or is not a directory`);
      }
      for (const file of listFiles(sourceDir)) this.addWatchFile(file);
    },
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
