// computerBundle: a Vite plugin that turns a project directory into a
// module a Worker can import and hand to WorkerBundle().
//
//   import skills from "computer:bundle/src/skills";
//   mounts: { "/workspace/.agents/skills": WorkerBundle(skills) }
//
// @cloudflare/vite-plugin never puts project files under /bundle, and
// under `vite dev` the Worker runs through Vite's module runner, so the
// node:fs form of WorkerBundle can't see them. Instead, the plugin
// resolves each `computer:bundle/<dir>` specifier to a virtual module
// whose body is a call to Vite's own `import.meta.glob`:
//
//   const files = import.meta.glob("./**/*", { base: "/src/skills", query: "?raw", import: "default" });
//   export default { version: "sha256:…", files };
//
// Vite then does the heavy lifting, the same way in dev and in build:
// each file becomes its own module, loaded only when the mount is
// copied in; edits and new files invalidate the module; and `vite
// build` emits one small chunk per file, which wrangler uploads as an
// ES module. `?raw` reads files as UTF-8 text, so this is for text
// files only. Like `import.meta.glob`, it skips dotfiles and
// node_modules.
//
// The plugin adds the version, a hash of the paths and contents,
// computed here at build time so the Worker never has to load every
// file to tell whether the bundle changed.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { Plugin } from "vite";

const SPECIFIER_PREFIX = "computer:bundle/";
// The \0 prefix is Vite's convention for virtual modules: other plugins
// leave the id alone and no file lookup is attempted.
const RESOLVED_PREFIX = `\0${SPECIFIER_PREFIX}`;

export function computerBundle(): Plugin {
  let root = "";

  return {
    name: "@cloudflare/computer:bundle",
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      if (!id.startsWith(SPECIFIER_PREFIX)) return undefined;
      return RESOLVED_PREFIX + normalizeDir(id.slice(SPECIFIER_PREFIX.length));
    },
    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) return undefined;
      const rel = id.slice(RESOLVED_PREFIX.length);
      const dir = resolve(root, rel);
      if (!isDirectory(dir)) {
        this.error(`computerBundle: ${dir} does not exist or is not a directory`);
      }
      const files = listFiles(dir);
      // A content edit only invalidates that file's own module, not this
      // one, so watch each file to keep the version current in dev.
      // Added and removed files are covered by Vite's glob handling.
      for (const file of files) this.addWatchFile(file);
      const base = JSON.stringify(`/${rel}`);
      return [
        `const files = import.meta.glob("./**/*", { base: ${base}, query: "?raw", import: "default" });`,
        `export default { version: ${JSON.stringify(hashFiles(dir, files))}, files };`,
        "",
      ].join("\n");
    },
  };
}

// The specifier names a directory relative to the Vite root.
function normalizeDir(dir: string): string {
  const segments = dir.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0) {
    throw new Error(
      `computerBundle: "${SPECIFIER_PREFIX}" needs a directory, such as "${SPECIFIER_PREFIX}src/skills"`,
    );
  }
  if (segments.includes("..")) {
    throw new Error(
      `computerBundle: directory must not contain '..' segments: ${JSON.stringify(dir)}`,
    );
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

// The same files `import.meta.glob("./**/*")` matches by default:
// everything except dotfiles, dot-directories and node_modules.
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function hashFiles(dir: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${relative(dir, file).split(sep).join("/")}\0`);
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
