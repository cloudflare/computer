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

/** What the mount negotiated and did with passthrough, read live. */
export interface PassthroughStatus {
  /** Asked for at init: local-only paths exist and it was not turned off. */
  readonly requested: boolean;
  /** The kernel offered the capability and computerd took it. */
  readonly negotiated: boolean;
  /** Opens handed to the kernel with a backing id. */
  readonly opens: number;
  /** Opens served by computerd because registration failed. */
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
    /** True once the kernel is serving local-only file data directly. */
    readonly passthrough: boolean;
    /**
     * Why passthrough is or is not active. Each inactive case has a
     * different fix, so each has its own wording.
     */
    readonly passthroughReason: string;
    readonly passthroughOpens: number;
    readonly passthroughFallbacks: number;
    /**
     * Off. libfuse 3 can negotiate it, but it changes write behavior for
     * the synced mount, which is a separate decision.
     */
    readonly writebackCache: false;
  };
}

/**
 * Builds the `ignore` block. `status` is the live passthrough state
 * from the mount, or undefined when no kernel FUSE mount is running.
 */
export function describeMountIgnore(
  config: MountIgnoreConfig,
  status?: PassthroughStatus,
): MountIgnoreInfo {
  const { passthrough, reason } = describePassthrough(config, status);
  return {
    supported: true,
    enabled: config.enabled,
    root: config.root,
    patterns: config.ignore.patterns,
    ineffectiveExclusions: config.ignore.ineffectiveExclusions,
    fastPaths: {
      passthrough,
      passthroughReason: reason,
      passthroughOpens: status?.opens ?? 0,
      passthroughFallbacks: status?.fallbacks ?? 0,
      writebackCache: false,
    },
  };
}

function describePassthrough(
  config: MountIgnoreConfig,
  status: PassthroughStatus | undefined,
): { passthrough: boolean; reason: string } {
  if (!config.enabled) {
    return { passthrough: false, reason: "no local-only paths are configured (MOUNT_IGNORE)" };
  }
  if (status === undefined) {
    return {
      passthrough: false,
      reason: "no kernel FUSE mount is running, so local-only paths are not passed through",
    };
  }
  if (!status.requested) {
    return { passthrough: false, reason: "turned off with COMPUTERD_FUSE_PASSTHROUGH" };
  }
  if (!status.negotiated) {
    return {
      passthrough: false,
      reason: "the kernel did not offer FUSE passthrough at init; it needs Linux 6.9 or newer",
    };
  }
  if (status.opens === 0 && status.fallbacks > 0) {
    return {
      passthrough: false,
      reason:
        `the kernel offered passthrough but refused every backing registration ` +
        `(${status.fallbacks}); check that computerd has CAP_SYS_ADMIN and that ` +
        `MOUNT_IGNORE_PATH is not on overlayfs stacked on another overlayfs`,
    };
  }
  if (status.opens === 0) {
    return {
      passthrough: false,
      reason: "negotiated, but no local-only file has been opened yet",
    };
  }
  return {
    passthrough: true,
    reason:
      status.fallbacks === 0
        ? "active"
        : `active; ${status.fallbacks} open(s) fell back to computerd after a refused registration`,
  };
}
