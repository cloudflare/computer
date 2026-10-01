// Local-only subpaths of the mount. See docs/20_local_only_paths.md.
//
// Entries are plain paths relative to the mount root: no glob syntax
// and no negation. Deliberate, because an entry then resolves to a
// known location and the mapping onto MOUNT_IGNORE_PATH is a prefix
// substitution decided at startup, which an unanchored pattern cannot
// answer until a path arrives to match against it.
//
// The set is resolved once at startup and never re-read: entries that
// changed under a running command would mean migrating
// already-materialised paths between layers mid-write.

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
  /** Segment-aware: `node_modules` does not match `node_modules_extra`. */
  readonly ignores: (relativePath: string) => boolean;
  /** The entry covering a path, or undefined when not local-only. */
  readonly entryFor: (relativePath: string) => string | undefined;
  /** Normalised entries, in declaration order, as the mount applies them. */
  readonly paths: readonly string[];
  /** Entries dropped as duplicates or as nested inside another entry. */
  readonly redundant: readonly string[];
  readonly isEmpty: boolean;
}

/**
 * Newline-delimited rather than comma- or space-separated because a
 * path may legally contain a comma or a space.
 */
export function parseMountIgnore(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const entries: string[] = [];
  for (const line of raw.split("\n")) {
    // Trailing whitespace is insignificant unless escaped, which is the
    // only way to name a path ending in a space.
    const trimmed = line.endsWith("\\ ") ? line.trimStart() : line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;
    entries.push(trimmed);
  }
  return entries;
}

/**
 * Normalises entries and builds the matcher. An absolute path outside
 * the mount is rejected rather than reinterpreted.
 */
export function resolveMountIgnore(entries: readonly string[], mountPoint = "/"): MountIgnoreSet {
  const root = normaliseMount(mountPoint);
  const paths: string[] = [];
  const redundant: string[] = [];

  for (const [index, original] of entries.entries()) {
    let value = original.trim();

    if (value.startsWith("/")) {
      if (root !== "/" && (value === root || value.startsWith(`${root}/`))) {
        value = value.slice(root.length);
      } else if (root !== "/") {
        throw new MountIgnorePathError(
          `Entry ${JSON.stringify(original)} is an absolute path outside the ` +
            `mount point ${JSON.stringify(root)}. Entries name paths within the mount.`,
          original,
          index,
        );
      }
    }

    const trimmed = stripSlashes(value);
    if (trimmed === "") {
      throw new MountIgnorePathError(
        `Entry ${JSON.stringify(original)} resolves to the mount root. ` +
          `Ignoring the whole mount would make the workspace non-durable.`,
        original,
        index,
      );
    }

    const segments = trimmed.split("/");
    // Rejected rather than resolved: silently clamping an entry that walks
    // out of the mount would hide the mistake behind a plausible path.
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw new MountIgnorePathError(
        `Entry ${JSON.stringify(original)} contains a "." or ".." segment. ` +
          `Entries must be plain paths relative to the mount root.`,
        original,
        index,
      );
    }
    if (segments.some((segment) => segment === "")) {
      throw new MountIgnorePathError(
        `Entry ${JSON.stringify(original)} contains an empty path segment.`,
        original,
        index,
      );
    }

    // Keeping `node_modules/.cache` alongside `node_modules` would imply
    // it does something, and it cannot.
    const covered = paths.some((existing) => isAtOrUnder(trimmed, existing));
    if (covered) {
      redundant.push(original);
      continue;
    }

    // The converse: a new entry may subsume ones already accepted.
    for (let position = paths.length - 1; position >= 0; position -= 1) {
      const existing = paths[position] as string;
      if (isAtOrUnder(existing, trimmed)) {
        redundant.push(existing);
        paths.splice(position, 1);
      }
    }

    paths.push(trimmed);
  }

  const isEmpty = paths.length === 0;

  const entryFor = (relativePath: string): string | undefined => {
    if (isEmpty) return undefined;
    const path = stripSlashes(relativePath);
    if (path === "") return undefined;
    return paths.find((entry) => isAtOrUnder(path, entry));
  };

  return {
    paths,
    redundant,
    isEmpty,
    entryFor,
    ignores: (relativePath) => entryFor(relativePath) !== undefined,
  };
}

/** The separator check is what stops `node_modules_extra` matching. */
function isAtOrUnder(path: string, entry: string): boolean {
  return path === entry || path.startsWith(`${entry}/`);
}

function stripSlashes(value: string): string {
  let out = value;
  while (out.startsWith("/")) out = out.slice(1);
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function normaliseMount(mountPoint: string): string {
  const trimmed = mountPoint.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}
