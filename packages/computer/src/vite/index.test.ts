import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import { createBuilder, type Plugin } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { workerBundle } from "./index.js";

const BINARY = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x7f]);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(join(tmpdir(), "worker-bundle-vite-"));
  tempDirs.push(root);
  const all: Record<string, string | Uint8Array> = {
    "wrangler.jsonc": JSON.stringify({
      name: "fixture",
      main: "src/index.js",
      compatibility_date: "2025-09-15",
      compatibility_flags: ["nodejs_compat"],
    }),
    "src/index.js": "export default { fetch() { return new Response('ok'); } };\n",
    ...files,
  };
  for (const [path, contents] of Object.entries(all)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

// createBuilder + buildApp rather than build(): the Cloudflare plugin
// builds the Worker as its own Vite environment, and build() only builds
// the client one. inspectorPort: false keeps the plugin from opening a
// debugger port the tests don't need.
async function build(root: string, plugins: Plugin[]): Promise<void> {
  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      cloudflare({ configPath: join(root, "wrangler.jsonc"), inspectorPort: false }),
      ...plugins,
    ],
  });
  await builder.buildApp();
}

function outputConfig(root: string): {
  rules: Array<{ type: string; globs: string[]; fallthrough?: boolean }>;
} {
  return JSON.parse(readFileSync(join(root, "dist/fixture/wrangler.json"), "utf8"));
}

const templates = {
  "src/templates/app/package.json": '{"name":"app"}\n',
  "src/templates/scripts/setup.sh": "#!/bin/sh\necho setup\n",
  "src/templates/assets/blob.bin": BINARY,
  "src/templates/README.md": "# Templates\n",
};

describe("workerBundle vite plugin", () => {
  it("emits the directory into the worker output with the same paths", async () => {
    const root = project(templates);
    await build(root, [workerBundle({ dir: "src/templates" })]);
    const out = join(root, "dist/fixture/templates");
    expect(readFileSync(join(out, "app/package.json"), "utf8")).toBe('{"name":"app"}\n');
    expect(readFileSync(join(out, "scripts/setup.sh"), "utf8")).toBe("#!/bin/sh\necho setup\n");
    expect(readFileSync(join(out, "README.md"), "utf8")).toBe("# Templates\n");
    expect(new Uint8Array(readFileSync(join(out, "assets/blob.bin")))).toEqual(BINARY);
  });

  it("puts a Data rule for the directory first in the generated wrangler.json", async () => {
    const root = project(templates);
    await build(root, [workerBundle({ dir: "src/templates" })]);
    const { rules } = outputConfig(root);
    expect(rules[0]).toEqual({ type: "Data", globs: ["templates/**/*"], fallthrough: true });
    expect(rules.slice(1)).toEqual([{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }]);
  });

  it("uses `as` for the output path and the rule", async () => {
    const root = project(templates);
    await build(root, [workerBundle({ dir: "src/templates", as: "seed/files" })]);
    expect(existsSync(join(root, "dist/fixture/seed/files/app/package.json"))).toBe(true);
    expect(outputConfig(root).rules[0].globs).toEqual(["seed/files/**/*"]);
  });

  it("adds one rule per directory and no duplicates", async () => {
    const root = project({ ...templates, "src/reference/a.txt": "a\n" });
    await build(root, [
      workerBundle({ dir: "src/templates" }),
      workerBundle({ dir: "src/reference" }),
      workerBundle({ dir: "src/templates" }),
    ]);
    const dataRules = outputConfig(root).rules.filter((rule) => rule.type === "Data");
    expect(dataRules.map((rule) => rule.globs)).toEqual([["reference/**/*"], ["templates/**/*"]]);
    expect(existsSync(join(root, "dist/fixture/reference/a.txt"))).toBe(true);
  });

  it("applies only to the named environment", async () => {
    const root = project(templates);
    await build(root, [workerBundle({ dir: "src/templates", environment: "other" })]);
    expect(existsSync(join(root, "dist/fixture/templates"))).toBe(false);
    expect(outputConfig(root).rules.some((rule) => rule.type === "Data")).toBe(false);
  });

  it("fails the build when the directory does not exist", async () => {
    const root = project({});
    await expect(build(root, [workerBundle({ dir: "src/missing" })])).rejects.toThrow(
      /does not exist/,
    );
  });

  it("rejects an `as` with .. segments", () => {
    expect(() => workerBundle({ dir: "src/templates", as: "../x" })).toThrow(/'\.\.'/);
  });
});
