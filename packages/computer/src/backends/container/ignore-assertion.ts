// Client-side check of the container's local-only path set. The backend
// passes `ignore` to the container as MOUNT_IGNORE at start, then reads
// back what computerd actually applied and refuses to connect if the two
// disagree. See packages/computerd/README.md.
//
// Fails the connection rather than warning, because the failure it
// guards is silent and expensive: a computerd too old to read
// MOUNT_IGNORE, or a MOUNT_IGNORE in `containerEnv` overriding the
// option, looks identical to a correct setup until a command writes a
// large dependency tree and the whole thing is pulled into the Durable
// Object -- the #179 symptom. A mismatch is a deployment error, and a
// loud one is cheaper than a slow one.

/** The `ignore` block computerd reports on /__computerd/info. */
export interface ComputerdIgnoreReport {
  readonly supported?: boolean;
  readonly enabled?: boolean;
  readonly root?: string;
  readonly paths?: readonly string[];
  readonly redundant?: readonly string[];
  readonly fastPaths?: Readonly<Record<string, unknown>>;
}

/** What the backend exposes back to the host after a successful connect. */
export interface ResolvedIgnore {
  /**
   * Absolute paths as they exist inside the container, under MOUNT_POINT.
   * `node_modules` with a mount of /workspace reports /workspace/node_modules,
   * so the value can be used directly against a container path without the
   * caller re-deriving the mount. Empty when the feature is off.
   */
  readonly paths: readonly string[];
  /**
   * Where local-only content is stored on the container's disk
   * (MOUNT_IGNORE_PATH). Undefined when unsupported.
   */
  readonly root: string | undefined;
  /** The mount point the paths are rooted at. Undefined when unsupported. */
  readonly mountPoint: string | undefined;
  /** False on a computerd predating the feature, so a host can degrade. */
  readonly supported: boolean;
}

/** Joins a mount-relative entry onto the mount point. */
function toContainerPath(entry: string, mountPoint: string): string {
  const base = mountPoint.replace(/\/+$/, "");
  const rel = entry.replace(/^\/+/, "");
  return `${base}/${rel}`;
}

export class ContainerIgnoreMismatchError extends Error {
  readonly declared: readonly string[];
  readonly actual: readonly string[];
  readonly supported: boolean;

  constructor(
    message: string,
    details: { declared: readonly string[]; actual: readonly string[]; supported: boolean },
  ) {
    super(message);
    this.name = "ContainerIgnoreMismatchError";
    this.declared = details.declared;
    this.actual = details.actual;
    this.supported = details.supported;
  }
}

/**
 * Reads the `ignore` block out of a /__computerd/info body.
 *
 * Tolerant by design: an older computerd has no such block, and that is
 * a supported answer (`supported: false`) rather than a parse error.
 * The caller decides whether it is acceptable.
 */
export function readIgnoreReport(info: unknown): ResolvedIgnore {
  if (typeof info !== "object" || info === null || !("ignore" in info)) {
    return { paths: [], root: undefined, mountPoint: undefined, supported: false };
  }
  const report = (info as { ignore?: unknown }).ignore;
  if (typeof report !== "object" || report === null) {
    return { paths: [], root: undefined, mountPoint: undefined, supported: false };
  }
  const typed = report as ComputerdIgnoreReport;
  if (typed.supported !== true) {
    return { paths: [], root: undefined, mountPoint: undefined, supported: false };
  }
  // computerd reports entries mount-relative; the host wants paths it can
  // use against the container directly, so they are joined onto the mount
  // point from the same payload.
  const mountPoint = (info as { mountPoint?: unknown }).mountPoint;
  const base = typeof mountPoint === "string" && mountPoint !== "" ? mountPoint : "/workspace";
  return {
    paths: Array.isArray(typed.paths) ? typed.paths.map((e) => toContainerPath(e, base)) : [],
    root: typeof typed.root === "string" ? typed.root : undefined,
    mountPoint: base,
    supported: true,
  };
}

/**
 * Compares a declared set against what the container applies; null when
 * they agree. Order-insensitive and duplicate-collapsing, because
 * computerd normalizes the same way and the two spellings mean the same
 * thing.
 */
export function diffIgnore(
  declared: readonly string[],
  actual: readonly string[],
): { missing: string[]; unexpected: string[] } | null {
  const declaredSet = new Set(declared.map(normalize));
  const actualSet = new Set(actual.map(normalize));

  const missing = [...declaredSet].filter((entry) => !actualSet.has(entry)).sort();
  const unexpected = [...actualSet].filter((entry) => !declaredSet.has(entry)).sort();

  if (missing.length === 0 && unexpected.length === 0) return null;
  return { missing, unexpected };
}

/**
 * Throws when the container disagrees. `declared === undefined` skips the
 * check, so an existing deployment cannot start failing because a new
 * field appeared.
 */
export function assertIgnoreMatches(
  declared: readonly string[] | undefined,
  resolved: ResolvedIgnore,
): void {
  if (declared === undefined) return;

  if (!resolved.supported) {
    throw new ContainerIgnoreMismatchError(
      `This container's computerd does not support local-only paths, but ` +
        `\`ignore\` declared ${formatList(declared)}. Those paths would be ` +
        `recorded in the workspace and pulled into the Durable Object. ` +
        `Upgrade the computerd image, or remove \`ignore\` to accept the ` +
        `container's behavior.`,
      { declared: [...declared], actual: [], supported: false },
    );
  }

  // resolved.paths are absolute container paths. A declaration may be
  // written mount-relative ("/node_modules") or with the mount point
  // ("/workspace/node_modules"), and computerd accepts both. Compare
  // both sides on the mount-relative form.
  const declaredRelative = declared.map((path) => stripMount(path, resolved.mountPoint));
  const actualRelative = resolved.paths.map((path) => stripMount(path, resolved.mountPoint));
  const difference = diffIgnore(declaredRelative, actualRelative);
  if (difference === null) return;

  const parts: string[] = [];
  if (difference.missing.length > 0) {
    parts.push(
      `declared but not applied by the container: ${formatList(difference.missing)} ` +
        `(these paths WILL be synced)`,
    );
  }
  if (difference.unexpected.length > 0) {
    parts.push(
      `applied by the container but not declared: ${formatList(difference.unexpected)} ` +
        `(these paths will NOT be synced)`,
    );
  }

  throw new ContainerIgnoreMismatchError(
    `Container ignore set does not match \`ignore\`: ${parts.join("; ")}. ` +
      `\`ignore\` is passed to the container as MOUNT_IGNORE, so a ` +
      `MOUNT_IGNORE in \`containerEnv\` overrides it. Remove one of them, ` +
      `or check that the computerd image reads MOUNT_IGNORE as a ` +
      `comma-separated list.`,
    { declared: [...declared], actual: [...resolved.paths], supported: true },
  );
}

/**
 * Reduces an absolute container path to its mount-relative form, so a
 * declaration and a report can be compared on the same footing.
 */
function stripMount(path: string, mountPoint: string | undefined): string {
  if (mountPoint === undefined) return path;
  const base = mountPoint.replace(/\/+$/, "");
  const trimmed = path.trim();
  if (base !== "" && (trimmed === base || trimmed.startsWith(`${base}/`))) {
    return trimmed.slice(base.length + 1);
  }
  return trimmed;
}

function normalize(entry: string): string {
  let value = entry.trim();
  while (value.startsWith("/")) value = value.slice(1);
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

function formatList(entries: readonly string[]): string {
  if (entries.length === 0) return "(none)";
  return entries.map((entry) => JSON.stringify(entry)).join(", ");
}
