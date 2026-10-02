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
  readonly patterns?: readonly string[];
  readonly ineffectiveExclusions?: readonly string[];
  readonly fastPaths?: Readonly<Record<string, unknown>>;
}

/** What the backend exposes back to the host after a successful connect. */
export interface ResolvedIgnore {
  /**
   * The MOUNT_IGNORE patterns computerd applied, normalized and in the
   * order written, for example `["/dist", "!/vendor/node_modules"]`.
   * Empty when the feature is off or unsupported.
   */
  readonly patterns: readonly string[];
  /**
   * Where local-only content is stored on the container's disk
   * (MOUNT_IGNORE_PATH). Undefined when unsupported.
   */
  readonly root: string | undefined;
  /** The mount point the patterns are anchored at. Undefined when unsupported. */
  readonly mountPoint: string | undefined;
  /** False on a computerd predating patterns, so a host can degrade. */
  readonly supported: boolean;
}

const UNSUPPORTED_REPORT: ResolvedIgnore = {
  patterns: [],
  root: undefined,
  mountPoint: undefined,
  supported: false,
};

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
 * Tolerant by design: an older computerd has no such block, or reports
 * plain `paths` from before patterns, and both are a supported answer
 * (`supported: false`) rather than a parse error. The caller decides
 * whether that is acceptable.
 */
export function readIgnoreReport(info: unknown): ResolvedIgnore {
  if (typeof info !== "object" || info === null || !("ignore" in info)) {
    return UNSUPPORTED_REPORT;
  }
  const report = (info as { ignore?: unknown }).ignore;
  if (typeof report !== "object" || report === null) return UNSUPPORTED_REPORT;
  const typed = report as ComputerdIgnoreReport;
  if (typed.supported !== true) return UNSUPPORTED_REPORT;
  const patterns: unknown = typed.patterns;
  if (!Array.isArray(patterns) || !patterns.every((entry) => typeof entry === "string")) {
    return UNSUPPORTED_REPORT;
  }
  const mountPoint = (info as { mountPoint?: unknown }).mountPoint;
  return {
    patterns,
    root: typeof typed.root === "string" ? typed.root : undefined,
    mountPoint: typeof mountPoint === "string" && mountPoint !== "" ? mountPoint : "/workspace",
    supported: true,
  };
}

// The same rules computerd applies at startup (computerd's
// src/fuse/ignore.ts). Duplicated rather than shared because this
// package does not depend on computerd; the two test suites pin the
// same cases. Checked in the backend constructor, so a typo fails before
// a container starts rather than as a daemon that exits during startup.
const MAX_PATTERN_LENGTH = 4096;
const UNSUPPORTED_SYNTAX = /[{}[\]?\\]/;

/** Throws on the first pattern computerd would refuse. */
export function checkIgnorePatterns(patterns: readonly string[]): void {
  for (const raw of patterns) {
    const pattern = raw.trim();
    const fail = (reason: string): never => {
      throw new Error(`\`ignore\` pattern ${JSON.stringify(raw)} ${reason}`);
    };
    if (pattern.length > MAX_PATTERN_LENGTH) {
      fail(`is longer than ${MAX_PATTERN_LENGTH} characters.`);
    }
    const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    if (!body.startsWith("/") && !body.startsWith("**/") && body !== "**") {
      const bare = stripSlashes(body.replace(/^\*\*(?=[^/])/, "")) || "path";
      fail(
        `must start with "/" (from the mount root) or "**/" (at any depth), ` +
          `for example "/${bare}" or "**/${bare}".`,
      );
    }
    if (UNSUPPORTED_SYNTAX.test(body)) {
      fail(`uses syntax that is not supported. Only "*", "**", and a leading "!" are.`);
    }
    if (body.includes(",")) {
      fail("contains a comma, which separates patterns in MOUNT_IGNORE.");
    }
    const trimmed = stripSlashes(body);
    const parts = trimmed === "" ? [] : trimmed.split("/");
    if (parts.some((part) => part === "")) fail("contains an empty path segment.");
    if (parts.some((part) => part === "." || part === "..")) {
      fail(`contains a "." or ".." segment.`);
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
  }
}

/**
 * Throws when the container is not applying exactly the declared
 * patterns, in the declared order. `declared === undefined` skips the
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
      `This container's computerd does not support MOUNT_IGNORE patterns, but ` +
        `\`ignore\` declared ${formatList(declared)}. Those paths would be ` +
        `recorded in the workspace and pulled into the Durable Object. ` +
        `Upgrade the computerd image, or remove \`ignore\` to accept the ` +
        `container's behavior.`,
      { declared: [...declared], actual: [], supported: false },
    );
  }

  // computerd reports patterns in a normalized spelling. Normalize the
  // declaration the same way, then compare in order: with exclusions,
  // the same patterns in a different order mean something different.
  const expected = declared.map((pattern) => normalizePattern(pattern, resolved.mountPoint));
  const actual = resolved.patterns.map((pattern) => normalizePattern(pattern, undefined));
  if (expected.length === actual.length && expected.every((value, i) => value === actual[i])) {
    return;
  }

  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((value) => !actualSet.has(value));
  const unexpected = actual.filter((value) => !expectedSet.has(value));
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`declared but not applied by the container: ${formatList(missing)}`);
  }
  if (unexpected.length > 0) {
    parts.push(`applied by the container but not declared: ${formatList(unexpected)}`);
  }
  if (parts.length === 0) {
    parts.push(
      `the container applies the same patterns in a different order ` +
        `(${formatList(actual)}), and the last matching pattern wins`,
    );
  }

  throw new ContainerIgnoreMismatchError(
    `Container MOUNT_IGNORE does not match \`ignore\`: ${parts.join("; ")}. ` +
      `\`ignore\` is passed to the container as MOUNT_IGNORE, so a ` +
      `MOUNT_IGNORE in \`containerEnv\` overrides it. Remove one of them, ` +
      `or check that the computerd image supports MOUNT_IGNORE patterns.`,
    { declared: [...declared], actual: [...resolved.patterns], supported: true },
  );
}

/**
 * computerd's spelling of a pattern: mount point and trailing slashes
 * stripped, a leading "/**" written as "**".
 */
function normalizePattern(raw: string, mountPoint: string | undefined): string {
  const pattern = raw.trim();
  const exclude = pattern.startsWith("!");
  let body = exclude ? pattern.slice(1) : pattern;
  const base = mountPoint?.replace(/\/+$/, "") ?? "";
  if (base !== "" && (body === base || body.startsWith(`${base}/`))) {
    body = body.slice(base.length) || "/";
  }
  const parts = stripSlashes(body).split("/");
  const canonical = parts[0] === "**" ? parts.join("/") : `/${parts.join("/")}`;
  return `${exclude ? "!" : ""}${canonical}`;
}

function stripSlashes(value: string): string {
  let out = value;
  while (out.startsWith("/")) out = out.slice(1);
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function formatList(entries: readonly string[]): string {
  if (entries.length === 0) return "(none)";
  return entries.map((entry) => JSON.stringify(entry)).join(", ");
}
