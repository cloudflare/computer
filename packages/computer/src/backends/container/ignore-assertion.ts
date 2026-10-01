// Client-side assertion over the container's local-only path set. The
// set is owned by the image; a client can only state what it expects
// and refuse to connect on disagreement. See docs/20_local_only_paths.md.
//
// Fails the connection rather than warning, because the failure it
// guards is silent and expensive: an image built without MOUNT_IGNORE
// looks identical to a correct one until a command writes a large
// dependency tree and the whole thing is pulled into the Durable
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
  /** Empty when the feature is off, indistinguishable from "no entries". */
  readonly paths: readonly string[];
  /** Resolved MOUNT_IGNORE_PATH, or undefined when unsupported. */
  readonly root: string | undefined;
  /** False on a computerd predating the feature, so a host can degrade. */
  readonly supported: boolean;
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
    return { paths: [], root: undefined, supported: false };
  }
  const report = (info as { ignore?: unknown }).ignore;
  if (typeof report !== "object" || report === null) {
    return { paths: [], root: undefined, supported: false };
  }
  const typed = report as ComputerdIgnoreReport;
  if (typed.supported !== true) {
    return { paths: [], root: undefined, supported: false };
  }
  return {
    paths: Array.isArray(typed.paths) ? [...typed.paths] : [],
    root: typeof typed.root === "string" ? typed.root : undefined,
    supported: true,
  };
}

/**
 * Compares a declared set against what the image applies; null when they
 * agree. Order-insensitive and duplicate-collapsing, because computerd
 * normalises the same way and the two spellings mean the same thing.
 */
export function diffIgnore(
  declared: readonly string[],
  actual: readonly string[],
): { missing: string[]; unexpected: string[] } | null {
  const declaredSet = new Set(declared.map(normalise));
  const actualSet = new Set(actual.map(normalise));

  const missing = [...declaredSet].filter((entry) => !actualSet.has(entry)).sort();
  const unexpected = [...actualSet].filter((entry) => !declaredSet.has(entry)).sort();

  if (missing.length === 0 && unexpected.length === 0) return null;
  return { missing, unexpected };
}

/**
 * Throws when the image disagrees. `declared === undefined` skips the
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
        `container's behaviour.`,
      { declared: [...declared], actual: [], supported: false },
    );
  }

  const difference = diffIgnore(declared, resolved.paths);
  if (difference === null) return;

  const parts: string[] = [];
  if (difference.missing.length > 0) {
    parts.push(
      `declared but not applied by the image: ${formatList(difference.missing)} ` +
        `(these paths WILL be synced)`,
    );
  }
  if (difference.unexpected.length > 0) {
    parts.push(
      `applied by the image but not declared: ${formatList(difference.unexpected)} ` +
        `(these paths will NOT be synced)`,
    );
  }

  throw new ContainerIgnoreMismatchError(
    `Container ignore set does not match \`ignore\`: ${parts.join("; ")}. ` +
      `The set is a property of the image (MOUNT_IGNORE), not of this ` +
      `client; \`ignore\` only asserts what the image is expected to apply. ` +
      `Rebuild the image or update the declaration so the two agree.`,
    { declared: [...declared], actual: [...resolved.paths], supported: true },
  );
}

function normalise(entry: string): string {
  let value = entry.trim();
  while (value.startsWith("/")) value = value.slice(1);
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

function formatList(entries: readonly string[]): string {
  if (entries.length === 0) return "(none)";
  return entries.map((entry) => JSON.stringify(entry)).join(", ");
}
