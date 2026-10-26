import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import { createBuilder, type Plugin } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { computerBundle } from "./index";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "computer-bundle-vite-"));
  tempDirs.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

const templates = {
  "src/templates/app/package.json": '{"name":"app"}\n',
  "src/templates/scripts/setup.sh": "#!/bin/sh\necho setup\n",
  "src/templates/README.md": "# Templates\n",
};

// The hooks are plain functions here, so the tests drive them directly
// with just enough of Vite's plugin context to observe what they do.
function hooks(root: string) {
  const plugin = computerBundle() as Plugin & {
    configResolved: (config: { root: string }) => void;
    resolveId: (id: string) => string | undefined;
    load: (this: unknown, id: string) => string | undefined;
  };
  plugin.configResolved({ root });
  const watched: string[] = [];
  const context = {
    addWatchFile: (file: string) => watched.push(file),
    error: (message: string) => {
      throw new Error(message);
    },
  };
  return {
    resolveId: (id: string) => plugin.resolveId(id),
    load: (id: string) => plugin.load.call(context, id),
    watched,
  };
}

function versionOf(code: string): string {
  const match = code.match(/version: "([^"]+)"/);
  if (match === null) throw new Error(`no version in ${code}`);
  return match[1];
}

describe("computerBundle vite plugin", () => {
  it("resolves computer:bundle specifiers to a normalized virtual module", () => {
    const { resolveId } = hooks(project(templates));
    expect(resolveId("computer:bundle/src/templates")).toBe("\0computer:bundle/src/templates");
    expect(resolveId("computer:bundle/./src//templates/")).toBe("\0computer:bundle/src/templates");
    expect(resolveId("./other.js")).toBeUndefined();
  });

  it("rejects an empty directory or .. segments", () => {
    const { resolveId } = hooks(project(templates));
    expect(() => resolveId("computer:bundle/")).toThrow(/needs a directory/);
    expect(() => resolveId("computer:bundle/../secrets")).toThrow(/'\.\.'/);
  });

  it("generates an import.meta.glob of the directory as raw text, with a version", () => {
    const { load } = hooks(project(templates));
    const code = load("\0computer:bundle/src/templates") ?? "";
    expect(code).toContain(
      'import.meta.glob("./**/*", { base: "/src/templates", query: "?raw", import: "default" })',
    );
    expect(code).toContain("export default { version: ");
    expect(versionOf(code)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("ignores ids it didn't resolve", () => {
    const { load } = hooks(project(templates));
    expect(load("/src/index.js")).toBeUndefined();
  });

  it("hashes paths and contents, skipping what import.meta.glob skips", () => {
    const root = project({
      ...templates,
      "src/templates/.hidden": "secret",
      "src/templates/node_modules/dep/index.js": "x",
    });
    const { load, watched } = hooks(root);
    const code = load("\0computer:bundle/src/templates") ?? "";

    const hash = createHash("sha256");
    for (const path of ["README.md", "app/package.json", "scripts/setup.sh"]) {
      hash.update(`${path}\0`);
      hash.update(readFileSync(join(root, "src/templates", path)));
      hash.update("\0");
    }
    expect(versionOf(code)).toBe(`sha256:${hash.digest("hex")}`);
    expect(watched.map((file) => file.slice(root.length + 1)).sort()).toEqual([
      "src/templates/README.md",
      "src/templates/app/package.json",
      "src/templates/scripts/setup.sh",
    ]);
  });

  it("changes the version when a file changes and keeps it otherwise", () => {
    const root = project(templates);
    const first = versionOf(hooks(root).load("\0computer:bundle/src/templates") ?? "");
    expect(versionOf(hooks(root).load("\0computer:bundle/src/templates") ?? "")).toBe(first);
    writeFileSync(join(root, "src/templates/README.md"), "# Changed\n");
    expect(versionOf(hooks(root).load("\0computer:bundle/src/templates") ?? "")).not.toBe(first);
  });

  it("fails when the directory does not exist", () => {
    const { load } = hooks(project(templates));
    expect(() => load("\0computer:bundle/src/missing")).toThrow(/does not exist/);
  });

  // createBuilder + buildApp rather than build(): the Cloudflare plugin
  // builds the Worker as its own Vite environment, and build() only
  // builds the client one. inspectorPort: false keeps the plugin from
  // opening a debugger port the tests don't need.
  it("builds into one chunk per file, with the glob and specifier compiled away", async () => {
    const root = project({
      ...templates,
      "wrangler.jsonc": JSON.stringify({
        name: "fixture",
        main: "src/index.js",
        compatibility_date: "2025-09-15",
        compatibility_flags: ["nodejs_compat"],
      }),
      "src/index.js": [
        'import templates from "computer:bundle/src/templates";',
        "export default { async fetch() { return Response.json(Object.keys(templates.files)); } };",
        "",
      ].join("\n"),
    });
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        cloudflare({ configPath: join(root, "wrangler.jsonc"), inspectorPort: false }),
        computerBundle(),
      ],
    });
    await builder.buildApp();

    const out = join(root, "dist/fixture");
    // The entry is index.js or index.mjs depending on the package type,
    // so take its name from the config the Cloudflare plugin wrote.
    const { main } = JSON.parse(readFileSync(join(out, "wrangler.json"), "utf8")) as {
      main: string;
    };
    const entry = readFileSync(join(out, main), "utf8");
    expect(entry).not.toContain("import.meta.glob");
    expect(entry).not.toContain("computer:bundle");
    expect(entry).toContain(versionOf(hooks(root).load("\0computer:bundle/src/templates") ?? ""));
    for (const key of ["./README.md", "./app/package.json", "./scripts/setup.sh"]) {
      expect(entry).toContain(JSON.stringify(key));
    }
    const chunks = readdirSync(join(out, "assets"));
    expect(chunks).toHaveLength(3);
    const contents = chunks
      .map((chunk) => readFileSync(join(out, "assets", chunk), "utf8"))
      .join("\n");
    expect(contents).toContain("echo setup");
  });
});
