// Local-only paths of the mount, as glob patterns. See
// packages/computerd/README.md.
//
// A small subset of gitignore: `*` within a path segment, `**` for any
// number of segments, and `!` to exclude. Every pattern is anchored: it
// starts with "/" (from the mount root) or "**/" (at any depth). The
// last matching pattern wins, and a path is local-only if it or any
// directory above it is ignored, which is git's rule. So an exclusion
// can only put back a path whose parent is still synced.
//
// A local-only path is stored at the same relative path under
// MOUNT_IGNORE_PATH, whichever pattern matched it.
//
// The patterns are resolved once at startup and never re-read: patterns
// that changed under a running command would mean migrating
// already-materialized paths between layers mid-write.

/** An entry that cannot be used, carrying enough context to fix it. */
export class MountIgnorePathError extends Error {
  readonly entry: string;
  readonly index: number;

  constructor(message: string, entry: string, index: number) {
    super(message);
    this.name = "MountIgnorePathError";
    this.entry = entry;
    this.index = index;
  }
}

export interface MountIgnoreSet {
  /** Whether a mount-relative path is local-only. Never touches disk. */
  readonly ignores: (relativePath: string) => boolean;
  /** Normalized patterns, in the order written. Order matters. */
  readonly patterns: readonly string[];
  /** Exclusions under a local-only directory, which therefore do nothing. */
  readonly ineffectiveExclusions: readonly string[];
  /** True when no pattern ignores anything. */
  readonly isEmpty: boolean;
}

/**
 * Comma-separated, so the set can be passed as a single start-time
 * environment variable. A path containing a comma cannot be expressed.
 */
export function parseMountIgnore(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const entries: string[] = [];
  for (const field of raw.split(",")) {
    const trimmed = field.trim();
    if (trimmed === "") continue;
    entries.push(trimmed);
  }
  return entries;
}

const MAX_PATTERN_LENGTH = 4096;
// Reserved rather than treated as literals, so nobody writes {js,ts}
// believing braces work. A comma never reaches here: it separates
// patterns in MOUNT_IGNORE.
const UNSUPPORTED = /[{}[\]?\\]/;

type Segment =
  | { kind: "literal"; value: string }
  | { kind: "wildcard"; regex: RegExp; sample: string }
  | { kind: "globstar" };

interface CompiledPattern {
  readonly source: string;
  readonly exclude: boolean;
  readonly segments: readonly Segment[];
}

/**
 * Validates and compiles the patterns. A pattern written with the mount
 * point ("/workspace/dist") means the same as one without ("/dist").
 */
export function resolveMountIgnore(entries: readonly string[], mountPoint = "/"): MountIgnoreSet {
  const root = normalizeMount(mountPoint);
  const compiled = entries.map((entry, index) => compilePattern(entry, index, root));

  const isEmpty = !compiled.some((pattern) => !pattern.exclude);

  // Walk the path's directories from the root. The first one whose last
  // matching pattern ignores it makes the whole path local-only.
  const ignores = (relativePath: string): boolean => {
    if (isEmpty) return false;
    const path = stripSlashes(relativePath);
    if (path === "") return false;
    const segments = path.split("/");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const prefix = segments.slice(0, depth);
      let ignored = false;
      for (const pattern of compiled) {
        if (matchSegments(pattern.segments, 0, prefix, 0)) ignored = !pattern.exclude;
      }
      if (ignored) return true;
    }
    return false;
  };

  return {
    ignores,
    isEmpty,
    patterns: compiled.map((pattern) => pattern.source),
    ineffectiveExclusions: compiled
      .filter((pattern) => pattern.exclude && isShadowed(pattern, ignores))
      .map((pattern) => pattern.source),
  };
}

function compilePattern(entry: string, index: number, root: string): CompiledPattern {
  const original = entry.trim();
  const fail = (reason: string): never => {
    throw new MountIgnorePathError(
      `MOUNT_IGNORE pattern ${JSON.stringify(original)} ${reason}`,
      entry,
      index,
    );
  };

  if (original.length > MAX_PATTERN_LENGTH) {
    fail(`is longer than ${MAX_PATTERN_LENGTH} characters.`);
  }
  const exclude = original.startsWith("!");
  let body = exclude ? original.slice(1) : original;

  if (!body.startsWith("/") && !body.startsWith("**/") && body !== "**") {
    const bare = stripSlashes(body.replace(/^\*\*(?=[^/])/, "")) || "path";
    fail(
      `must start with "/" (from the mount root) or "**/" (at any depth), ` +
        `for example "/${bare}" or "**/${bare}".`,
    );
  }
  if (UNSUPPORTED.test(body)) {
    fail(`uses syntax that is not supported. Only "*", "**", and a leading "!" are.`);
  }

  // A leading slash anchors at the mount root, so the mount point itself
  // is optional: "/workspace/dist" is "/dist".
  if (root !== "/" && (body === root || body.startsWith(`${root}/`))) {
    body = body.slice(root.length) || "/";
  }

  const trimmed = stripSlashes(body);
  const parts = trimmed === "" ? [] : trimmed.split("/");
  if (parts.some((part) => part === "")) fail("contains an empty path segment.");
  if (parts.some((part) => part === "." || part === "..")) {
    fail(`contains a "." or ".." segment. Patterns name paths under the mount root.`);
  }
  if (parts.some((part) => part !== "**" && part.includes("**"))) {
    fail(`uses "**" inside a segment. "**" must be a whole path segment.`);
  }
  // Only "*" and "**" segments match every path at some depth, and
  // everything under a local-only directory is local-only: "/*" alone
  // would keep the whole workspace off the Durable Object.
  if (parts.every((part) => part === "**" || part === "*")) {
    fail("would make the whole mount local-only, so nothing would be synced.");
  }

  const segments = parts.map(compileSegment);
  const canonical = parts[0] === "**" ? parts.join("/") : `/${parts.join("/")}`;
  return { source: `${exclude ? "!" : ""}${canonical}`, exclude, segments };
}

function compileSegment(part: string): Segment {
  if (part === "**") return { kind: "globstar" };
  if (!part.includes("*")) return { kind: "literal", value: part };
  const source = part
    .split("*")
    .map((piece) => piece.replace(/[.+^$|()\\/]/g, "\\$&"))
    .join("[^/]*");
  return { kind: "wildcard", regex: new RegExp(`^${source}$`), sample: part.replaceAll("*", "x") };
}

/** Whether `pattern[p..]` matches exactly `path[i..]`. */
function matchSegments(
  pattern: readonly Segment[],
  p: number,
  path: readonly string[],
  i: number,
): boolean {
  if (p === pattern.length) return i === path.length;
  const segment = pattern[p] as Segment;
  if (segment.kind === "globstar") {
    // Zero or more segments: try every split.
    for (let skip = i; skip <= path.length; skip += 1) {
      if (matchSegments(pattern, p + 1, path, skip)) return true;
    }
    return false;
  }
  if (i === path.length) return false;
  const name = path[i] as string;
  const ok = segment.kind === "literal" ? name === segment.value : segment.regex.test(name);
  return ok && matchSegments(pattern, p + 1, path, i + 1);
}

// An exclusion does nothing if a directory above what it names is
// local-only. Checked on one sample path, with "**" dropped and each "*"
// filled in, which is enough to catch "!**/node_modules/.bin" without
// any glob algebra.
function isShadowed(pattern: CompiledPattern, ignores: (path: string) => boolean): boolean {
  const sample = pattern.segments
    .filter((segment) => segment.kind !== "globstar")
    .map((segment) => (segment.kind === "literal" ? segment.value : segment.sample));
  for (let depth = 1; depth < sample.length; depth += 1) {
    if (ignores(sample.slice(0, depth).join("/"))) return true;
  }
  return false;
}

function stripSlashes(value: string): string {
  let out = value;
  while (out.startsWith("/")) out = out.slice(1);
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function normalizeMount(mountPoint: string): string {
  const trimmed = mountPoint.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}
