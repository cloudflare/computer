// Local-only subpaths of the mount.
//
// Addresses #179: everything a container command writes under
// MOUNT_POINT is recorded in the VFS and pulled into the Durable
// Object after the command. That is right for source and wrong for
// node_modules, .venv, target/ and dist/ -- tens of thousands of
// rebuildable files that never need to be durable. Paths listed here
// pass through to local disk instead, are never recorded in the VFS,
// and are never pushed or pulled.
//
// Entries are plain paths relative to the mount root. There is no
// glob syntax and no negation: an entry names one location, and a
// path is local-only if it equals that entry or sits underneath it.
//
// The simplicity is the design, not a shortcut. Three things follow
// from it that a pattern language does not give you:
//
//   - An entry resolves to a known location, so the mapping onto
//     MOUNT_IGNORE_PATH is a prefix substitution decided at startup.
//     An unanchored pattern has no single answer to "where does this
//     live on disk" until a path arrives to match against it.
//   - Matching is a segment-aware prefix test, which the driver's
//     per-inode decision cache collapses to one lookup per directory.
//   - The set of paths that silently lose durability is reviewable by
//     reading it. That matters more here than expressiveness, because
//     the cost of a wrong entry is data that exists only inside one
//     container.
//
// The one real limitation is that `node_modules` does not match at
// every depth. A monorepo cloning packages into app/, web/ and api/
// lists each `<pkg>/node_modules`. That is more lines in a Dockerfile
// and nothing more. If depth matching is ever needed, a single
// leading `**/` form is the smallest addition that stays resolvable;
// add it on evidence rather than in anticipation.
//
// The set is fixed for the life of the mount. It is resolved once at
// startup from MOUNT_IGNORE and never re-read: entries that changed
// under a running command would mean migrating already-materialised
// paths between layers mid-write.

/** An entry that cannot be used, carrying enough context to fix it. */
export class MountIgnorePathError extends Error {
  readonly entry: string;
  /** Index into the entry list, so a long MOUNT_IGNORE is diagnosable. */
  readonly index: number;

  constructor(message: string, entry: string, index: number) {
    super(message);
    this.name = "MountIgnorePathError";
    this.entry = entry;
    this.index = index;
  }
}

export interface MountIgnoreSet {
  /**
   * Whether a mount-relative path is local-only.
   *
   * True when the path equals an entry or is a descendant of one.
   * Matching is segment-aware, so the entry `node_modules` does not
   * match `node_modules_extra`.
   */
  readonly ignores: (relativePath: string) => boolean;
  /**
   * The entry covering a path, for error messages and diagnostics.
   * Undefined when the path is not local-only.
   */
  readonly entryFor: (relativePath: string) => string | undefined;
  /** Normalised entries, in declaration order, as the mount applies them. */
  readonly paths: readonly string[];
  /** Entries dropped as duplicates or as nested inside another entry. */
  readonly redundant: readonly string[];
  readonly isEmpty: boolean;
}

/**
 * Splits a raw MOUNT_IGNORE value into entries.
 *
 * Newline-delimited rather than comma- or space-separated because a
 * path may legally contain a comma or a space. Blank lines and `#`
 * comments are skipped so a generated block stays readable in a
 * Dockerfile ENV.
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
 * Normalises entries and builds the matcher.
 *
 * `mountPoint` lets an absolute path under the mount be written as
 * `/workspace/dist`, which is the obvious thing to reach for. An
 * absolute path outside the mount is rejected rather than reinterpreted.
 */
export function resolveMountIgnore(entries: readonly string[], mountPoint = "/"): MountIgnoreSet {
  const root = normaliseMount(mountPoint);
  const paths: string[] = [];
  const redundant: string[] = [];

  for (const [index, original] of entries.entries()) {
    let value = original.trim();

    if (value.startsWith("/")) {
      // Absolute. Accept it only if it names something inside the mount.
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
    // `.` and `..` are rejected rather than resolved. An entry that walks
    // out of the mount is a configuration mistake, and silently clamping
    // it would hide the mistake behind a path that looks intentional.
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

    // Duplicates and entries nested inside an existing one are dropped:
    // keeping `node_modules/.cache` alongside `node_modules` would imply
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

/**
 * Whether `path` is `entry` or sits beneath it.
 *
 * The separator check is what makes this segment-aware. A plain
 * `startsWith` would report `node_modules_extra` as being under
 * `node_modules`, which is the single easiest way to get this wrong and
 * the reason the near-miss has its own test.
 */
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
