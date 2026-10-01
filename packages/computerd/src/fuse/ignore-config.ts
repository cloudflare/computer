// Startup resolution of the local-only path configuration.
//
// Reads MOUNT_IGNORE and MOUNT_IGNORE_PATH, validates them against the
// mount point, and produces the value the driver and /__computerd/info
// both consume. Kept apart from ignore.ts so the matcher stays a pure
// function of its inputs with no env or filesystem opinions.
//
// Everything here fails closed. A misconfiguration that silently
// disabled the feature would send a full node_modules into the Durable
// Object, which is the exact failure #179 is about, so the daemon
// refuses to mount instead.

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
 * Default root: /tmp + the mount point.
 *
 * Under /tmp rather than a tmpfs or an anonymous volume so a container
 * snapshot captures it. That is the only durability local-only content
 * has -- it is deliberately absent from sync -- so putting it somewhere
 * a snapshot misses would make container replacement silently lose the
 * tree this feature exists to keep.
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

  const normalisedRoot = resolve(root).replace(/\/+$/, "") || "/";
  const normalisedMount = resolve(mountPoint).replace(/\/+$/, "") || "/";

  // The store must not live inside the thing it shadows. A root under
  // the mount would make the passthrough layer resolve into itself:
  // every write to an ignored path would land at a location that is
  // also an ignored path, one level deeper, forever.
  if (normalisedRoot === normalisedMount || normalisedRoot.startsWith(`${normalisedMount}/`)) {
    throw new Error(
      `MOUNT_IGNORE_PATH (${normalisedRoot}) must not be inside MOUNT_POINT ` +
        `(${normalisedMount}); local-only paths are stored outside the mount.`,
    );
  }

  if (normalisedRoot === "/") {
    throw new Error("MOUNT_IGNORE_PATH must not be the filesystem root");
  }

  return { root: normalisedRoot, ignore, enabled: !ignore.isEmpty };
}

/** The `ignore` block reported on /__computerd/info. */
export interface MountIgnoreInfo {
  readonly supported: true;
  readonly enabled: boolean;
  readonly root: string;
  readonly paths: readonly string[];
  readonly redundant: readonly string[];
  readonly fastPaths: {
    /**
     * FUSE passthrough (FOPEN_PASSTHROUGH).
     *
     * Always false on this build, and reported rather than omitted so
     * the reason is visible without reading the source. computerd mounts
     * through fuse-native, which binds libfuse 2.9; passthrough needs
     * the libfuse 3.17 API. The host kernel supports it, so this flips
     * on a binding change rather than an infrastructure change.
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
    paths: config.ignore.paths,
    redundant: config.ignore.redundant,
    fastPaths: {
      passthrough: false,
      passthroughReason: PASSTHROUGH_UNAVAILABLE_REASON,
      writebackCache: false,
    },
  };
}
