// Startup resolution of the local-only path configuration. Kept apart
// from ignore.ts so the matcher stays a pure function of its inputs.
//
// Fails closed: a misconfiguration that silently disabled the feature
// would send a full node_modules into the Durable Object, the exact
// failure #179 is about, so the daemon refuses to mount instead.

import { isAbsolute, join, resolve } from "node:path";

import { type MountIgnoreSet, parseMountIgnore, resolveMountIgnore } from "./ignore.js";

export interface MountIgnoreConfig {
  /** Where local-only paths are stored. Absolute, outside the mount. */
  readonly root: string;
  /** The resolved set. Empty when the feature is off. */
  readonly ignore: MountIgnoreSet;
  /** True when at least one path is configured. */
  readonly enabled: boolean;
}

export interface MountIgnoreEnv {
  MOUNT_IGNORE?: string;
  MOUNT_IGNORE_PATH?: string;
}

/**
 * Default root: /tmp + the mount point. Under /tmp rather than a tmpfs
 * so a container snapshot captures it -- that is the only durability
 * local-only content has, being deliberately absent from sync.
 */
export function defaultIgnoreRoot(mountPoint: string): string {
  return join("/tmp", mountPoint);
}

export function resolveMountIgnoreConfig(
  env: MountIgnoreEnv,
  mountPoint: string,
): MountIgnoreConfig {
  const entries = parseMountIgnore(env.MOUNT_IGNORE);
  const ignore = resolveMountIgnore(entries, mountPoint);

  const configuredRoot = env.MOUNT_IGNORE_PATH?.trim();
  const root =
    configuredRoot === undefined || configuredRoot === ""
      ? defaultIgnoreRoot(mountPoint)
      : configuredRoot;

  if (!isAbsolute(root)) {
    throw new Error(`MOUNT_IGNORE_PATH must be an absolute path, got ${JSON.stringify(root)}`);
  }

  const normalizedRoot = resolve(root).replace(/\/+$/, "") || "/";
  const normalizedMount = resolve(mountPoint).replace(/\/+$/, "") || "/";

  // A root under the mount would make the passthrough layer resolve into
  // itself: every write to an ignored path would land at a location that
  // is also an ignored path, one level deeper, forever.
  if (normalizedRoot === normalizedMount || normalizedRoot.startsWith(`${normalizedMount}/`)) {
    throw new Error(
      `MOUNT_IGNORE_PATH (${normalizedRoot}) must not be inside MOUNT_POINT ` +
        `(${normalizedMount}); local-only paths are stored outside the mount.`,
    );
  }

  if (normalizedRoot === "/") {
    throw new Error("MOUNT_IGNORE_PATH must not be the filesystem root");
  }

  return { root: normalizedRoot, ignore, enabled: !ignore.isEmpty };
}

export interface PassthroughStatus {
  /** Local-only paths exist and COMPUTERD_FUSE_PASSTHROUGH did not turn it off. */
  readonly requested: boolean;
  readonly negotiated: boolean;
  readonly opens: number;
  readonly fallbacks: number;
}

/** The `ignore` block reported on /__computerd/info. */
export interface MountIgnoreInfo {
  readonly supported: true;
  readonly enabled: boolean;
  readonly root: string;
  // Patterns, not paths: "**/node_modules" can't be joined onto the
  // mount point.
  readonly patterns: readonly string[];
  readonly ineffectiveExclusions: readonly string[];
  readonly fastPaths: {
    readonly passthrough: boolean;
    readonly passthroughReason: string;
    readonly passthroughOpens: number;
    readonly passthroughFallbacks: number;
    /** Possible under libfuse 3, but it would change writes on the synced mount. */
    readonly writebackCache: false;
  };
}

/** `status` is undefined when no kernel FUSE mount is running. */
export function describeMountIgnore(
  config: MountIgnoreConfig,
  status?: PassthroughStatus,
): MountIgnoreInfo {
  const inactive = inactivePassthroughReason(config, status);
  return {
    supported: true,
    enabled: config.enabled,
    root: config.root,
    patterns: config.ignore.patterns,
    ineffectiveExclusions: config.ignore.ineffectiveExclusions,
    fastPaths: {
      passthrough: inactive === undefined,
      passthroughReason: inactive ?? activeReason(status?.fallbacks ?? 0),
      passthroughOpens: status?.opens ?? 0,
      passthroughFallbacks: status?.fallbacks ?? 0,
      writebackCache: false,
    },
  };
}

// Each case has a different fix, so each gets its own wording.
function inactivePassthroughReason(
  config: MountIgnoreConfig,
  status: PassthroughStatus | undefined,
): string | undefined {
  if (!config.enabled) return "no local-only paths are configured (MOUNT_IGNORE)";
  if (status === undefined) {
    return "no kernel FUSE mount is running, so local-only paths are not passed through";
  }
  if (!status.requested) return "turned off with COMPUTERD_FUSE_PASSTHROUGH";
  if (!status.negotiated) {
    return "the kernel did not offer FUSE passthrough at init; it needs Linux 6.9 or newer";
  }
  if (status.opens > 0) return undefined;
  if (status.fallbacks > 0) {
    return (
      `the kernel offered passthrough but refused every backing registration ` +
      `(${status.fallbacks}); check that computerd has CAP_SYS_ADMIN and that ` +
      `MOUNT_IGNORE_PATH is not on overlayfs stacked on another overlayfs`
    );
  }
  return "negotiated, but no local-only file has been opened yet";
}

function activeReason(fallbacks: number): string {
  return fallbacks === 0
    ? "active"
    : `active; ${fallbacks} open(s) fell back to computerd after a refused registration`;
}
