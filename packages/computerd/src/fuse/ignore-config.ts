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
    /**
     * Always false: fuse-native binds libfuse 2.9, passthrough needs the
     * libfuse 3.17 API. Reported rather than omitted so the reason is
     * visible without reading the source.
     */
    readonly passthrough: false;
    readonly passthroughReason: string;
    /** Also unavailable: libfuse 2.9 fails the mount on the option. */
    readonly writebackCache: false;
  };
}

export const PASSTHROUGH_UNAVAILABLE_REASON =
  "fuse-native binds libfuse 2.9; FOPEN_PASSTHROUGH requires the libfuse 3.17 API";

export function describeMountIgnore(config: MountIgnoreConfig): MountIgnoreInfo {
  return {
    supported: true,
    enabled: config.enabled,
    root: config.root,
    patterns: config.ignore.patterns,
    ineffectiveExclusions: config.ignore.ineffectiveExclusions,
    fastPaths: {
      passthrough: false,
      passthroughReason: PASSTHROUGH_UNAVAILABLE_REASON,
      writebackCache: false,
    },
  };
}
