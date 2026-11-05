/**
 * Selecting workspace files: globs plus `.gitignore` rules. The same semantics
 * as remote-exec's Rust walker (packages/remote-exec/src/walk.rs); the shared fixtures keep them together.
 */
import ignore, { type Ignore } from "ignore";
import picomatch from "picomatch";
import { isNotFound, join, readAll, type SyncFs } from "./fs";

const MATCH_OPTIONS = { dot: true } as const;

function staticPrefix(pattern: string): string {
  const parts = pattern.split("/");
  const literal: string[] = [];
  for (const part of parts) {
    if (/[*?[{\\]/.test(part)) break;
    literal.push(part);
  }
  // The last literal segment may be a file name; keep only directories.
  if (literal.length === parts.length) literal.pop();
  return literal.join("/");
}

export class Selector {
  readonly #positive: (path: string) => boolean;
  readonly #negative: (path: string) => boolean;
  readonly #prefixes: string[];

  constructor(globs: readonly string[]) {
    const positive: string[] = [];
    const negative: string[] = [];
    for (const g of globs) {
      if (g.startsWith("!")) negative.push(g.slice(1));
      else positive.push(g);
    }
    this.#positive = positive.length ? picomatch(positive, MATCH_OPTIONS) : () => false;
    this.#negative = negative.length ? picomatch(negative, MATCH_OPTIONS) : () => false;
    this.#prefixes = positive.map(staticPrefix);
  }

  get isEmpty(): boolean {
    return this.#prefixes.length === 0;
  }

  matches(rel: string): boolean {
    return this.#positive(rel) && !this.#negative(rel);
  }

  mayEnter(dir: string): boolean {
    return this.#prefixes.some(
      (p) => p === "" || p === dir || p.startsWith(`${dir}/`) || dir.startsWith(`${p}/`),
    );
  }
}

const GLOB_SYNTAX = /[*?[\]{}]/;

/** `path` without trailing slashes. A loop rather than `/\/+$/`, which is slow on long runs of "/". */
function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end--;
  return path.slice(0, end);
}

/** Resolves "." and ".." segments; undefined when ".." would leave the start or follow a glob. */
function resolveSegments(segments: readonly string[]): string[] | undefined {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      out.push(segment);
      continue;
    }
    const top = out.at(-1);
    if (top === undefined || GLOB_SYNTAX.test(top)) return undefined;
    out.pop();
  }
  return out;
}

/**
 * `cwd` as a path relative to `root`: "" for the root itself or no cwd, undefined when it's
 * outside the root. A relative cwd is relative to the root.
 */
export function relativeCwd(cwd: string | undefined, root: string): string | undefined {
  const base = trimTrailingSlashes(root);
  if (cwd === undefined || cwd === "") return "";
  let rel = cwd;
  if (cwd.startsWith("/")) {
    const path = trimTrailingSlashes(cwd);
    if (path === base) return "";
    if (!path.startsWith(`${base}/`)) return undefined;
    rel = path.slice(base.length + 1);
  }
  return resolveSegments(rel.split("/"))?.join("/");
}

/**
 * Normalise globs to be relative to `root`. Relative globs are relative to `cwd` (default: the
 * root), as the command's own paths are; absolute globs must be under the root. Nothing may
 * reach outside the root.
 */
export function normalizeGlobs(
  globs: readonly string[] | undefined,
  root: string,
  cwd?: string,
): string[] {
  const base = trimTrailingSlashes(root);
  const from = relativeCwd(cwd, root);
  return (globs ?? []).map((raw) => {
    const negated = raw.startsWith("!");
    const glob = negated ? raw.slice(1) : raw;
    let segments: string[];
    if (glob.startsWith("/")) {
      if (glob === base || !glob.startsWith(`${base}/`))
        throw new TypeError(`exec: glob ${JSON.stringify(raw)} is outside ${root}`);
      segments = glob.slice(base.length + 1).split("/");
    } else {
      if (from === undefined)
        throw new TypeError(
          `exec: glob ${JSON.stringify(raw)} is relative to cwd ${JSON.stringify(cwd)}, which is outside ${root}: give it as ${base}/...`,
        );
      segments = [...(from ? from.split("/") : []), ...glob.split("/")];
    }
    const resolved = resolveSegments(segments);
    if (resolved === undefined)
      throw new TypeError(
        `exec: glob ${JSON.stringify(raw)} isn't valid: it reaches outside ${root}`,
      );
    if (resolved.length === 0) throw new TypeError(`exec: glob ${JSON.stringify(raw)} isn't valid`);
    return `${negated ? "!" : ""}${resolved.join("/")}`;
  });
}

export interface Found {
  rel: string;
  kind: "file" | "symlink";
  mode: number;
  size: number;
  target: string;
}

export interface Walked {
  found: Found[];
  skipped: { path: string; reason: string }[];
}

interface Rules {
  base: string;
  ig: Ignore;
}

export function linkStaysInside(rel: string, target: string): boolean {
  if (target.startsWith("/")) return false;
  let depth = rel.split("/").length - 1;
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    depth += part === ".." ? -1 : 1;
    if (depth < 0) return false;
  }
  return true;
}

function ignored(rules: readonly Rules[], rel: string, isDir: boolean): boolean {
  let state = false;
  for (const { base, ig } of rules) {
    if (base !== "" && !rel.startsWith(`${base}/`)) continue;
    const local = base === "" ? rel : rel.slice(base.length + 1);
    const result = ig.test(isDir ? `${local}/` : local);
    if (result.ignored) state = true;
    else if (result.unignored) state = false;
  }
  return state;
}

async function readText(fs: SyncFs, path: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await readAll(await fs.readFile(path)));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

const PAGE = 1000;

async function listAll(fs: SyncFs, path: string) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await fs.readdir(path, { limit: PAGE, offset });
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

export async function walkWorkspace(fs: SyncFs, root: string, selector: Selector): Promise<Walked> {
  const walked: Walked = { found: [], skipped: [] };
  if (selector.isEmpty) return walked;
  const rules: Rules[] = [];
  const exclude = await readText(fs, join(root, ".git/info/exclude"));
  if (exclude !== undefined) rules.push({ base: "", ig: ignore().add(exclude) });

  const visit = async (dirRel: string, inherited: Rules[]): Promise<void> => {
    let entries;
    try {
      entries = await listAll(fs, join(root, dirRel));
    } catch (error) {
      if (isNotFound(error) && dirRel === "") return;
      walked.skipped.push({ path: dirRel, reason: "unreadable" });
      return;
    }
    let local = inherited;
    if (entries.some((e) => e.name === ".gitignore" && e.isFile)) {
      const text = await readText(fs, join(root, dirRel ? `${dirRel}/.gitignore` : ".gitignore"));
      if (text !== undefined) local = [...inherited, { base: dirRel, ig: ignore().add(text) }];
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isDirectory && !entry.isSymbolicLink) {
        if (!ignored(local, rel, true) && selector.mayEnter(rel)) await visit(rel, local);
        continue;
      }
      if (ignored(local, rel, false) || !selector.matches(rel)) continue;
      if (rel.includes("\n")) {
        walked.skipped.push({ path: rel, reason: "unsupported" });
      } else if (entry.isSymbolicLink) {
        const target = await fs.readlink(join(root, rel));
        if (linkStaysInside(rel, target))
          walked.found.push({ rel, kind: "symlink", mode: 0o777, size: 0, target });
        else walked.skipped.push({ path: rel, reason: "symlink-escape" });
      } else if (entry.isFile) {
        const stat = await fs.lstat(join(root, rel));
        // Stores that don't track modes report 0; treat that as an ordinary file.
        walked.found.push({
          rel,
          kind: "file",
          mode: stat.mode & 0o7777 || 0o644,
          size: stat.size,
          target: "",
        });
      } else {
        walked.skipped.push({ path: rel, reason: "unsupported" });
      }
    }
  };
  await visit("", rules);
  return walked;
}
