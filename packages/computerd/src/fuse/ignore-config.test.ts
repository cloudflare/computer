import { describe, expect, test } from "vitest";

import {
  defaultIgnoreRoot,
  describeMountIgnore,
  resolveMountIgnoreConfig,
} from "./ignore-config.js";

describe("resolveMountIgnoreConfig: the root", () => {
  test("defaults to /tmp plus the mount point", () => {
    // Under /tmp rather than a tmpfs so a container snapshot captures
    // it. Snapshots are the only durability local-only content has.
    expect(defaultIgnoreRoot("/workspace")).toBe("/tmp/workspace");
    const config = resolveMountIgnoreConfig({ MOUNT_IGNORE: "/node_modules" }, "/workspace");
    expect(config.root).toBe("/tmp/workspace");
  });

  test("honors an explicit MOUNT_IGNORE_PATH", () => {
    const config = resolveMountIgnoreConfig(
      { MOUNT_IGNORE: "/node_modules", MOUNT_IGNORE_PATH: "/var/local-only" },
      "/workspace",
    );
    expect(config.root).toBe("/var/local-only");
  });

  test("strips a trailing slash", () => {
    const config = resolveMountIgnoreConfig(
      { MOUNT_IGNORE: "/dist", MOUNT_IGNORE_PATH: "/var/local/" },
      "/workspace",
    );
    expect(config.root).toBe("/var/local");
  });

  test("rejects a relative MOUNT_IGNORE_PATH", () => {
    expect(() =>
      resolveMountIgnoreConfig(
        { MOUNT_IGNORE: "/dist", MOUNT_IGNORE_PATH: "relative/path" },
        "/workspace",
      ),
    ).toThrow(/absolute path/);
  });

  test("rejects a root inside the mount point", () => {
    // The passthrough layer would resolve into itself: every write to
    // an ignored path lands at a location that is also an ignored path.
    expect(() =>
      resolveMountIgnoreConfig(
        { MOUNT_IGNORE: "/dist", MOUNT_IGNORE_PATH: "/workspace/.local" },
        "/workspace",
      ),
    ).toThrow(/must not be inside MOUNT_POINT/);
  });

  test("rejects a root equal to the mount point", () => {
    expect(() =>
      resolveMountIgnoreConfig(
        { MOUNT_IGNORE: "/dist", MOUNT_IGNORE_PATH: "/workspace" },
        "/workspace",
      ),
    ).toThrow(/must not be inside MOUNT_POINT/);
  });

  test("rejects the filesystem root", () => {
    expect(() =>
      resolveMountIgnoreConfig({ MOUNT_IGNORE: "/dist", MOUNT_IGNORE_PATH: "/" }, "/workspace"),
    ).toThrow(/filesystem root/);
  });

  test("allows a sibling path that merely shares a prefix string", () => {
    // /workspace-cache is not inside /workspace, despite startsWith.
    const config = resolveMountIgnoreConfig(
      { MOUNT_IGNORE: "/dist", MOUNT_IGNORE_PATH: "/workspace-cache" },
      "/workspace",
    );
    expect(config.root).toBe("/workspace-cache");
  });
});

describe("resolveMountIgnoreConfig: the set", () => {
  test("is disabled when MOUNT_IGNORE is absent", () => {
    const config = resolveMountIgnoreConfig({}, "/workspace");
    expect(config.enabled).toBe(false);
    expect(config.ignore.isEmpty).toBe(true);
  });

  test("is disabled when MOUNT_IGNORE is only separators and blanks", () => {
    const config = resolveMountIgnoreConfig({ MOUNT_IGNORE: " , ,  " }, "/workspace");
    expect(config.enabled).toBe(false);
  });

  test("resolves entries relative to the mount point", () => {
    const config = resolveMountIgnoreConfig(
      { MOUNT_IGNORE: "/node_modules,/workspace/dist" },
      "/workspace",
    );
    expect(config.enabled).toBe(true);
    expect(config.ignore.patterns).toEqual(["/node_modules", "/dist"]);
  });

  test("propagates a bad entry as a startup failure", () => {
    // Failing closed matters: a silently dropped entry sends a full
    // node_modules into the DO, which is the failure #179 is about.
    expect(() => resolveMountIgnoreConfig({ MOUNT_IGNORE: "/../escape" }, "/workspace")).toThrow();
  });
});

describe("describeMountIgnore", () => {
  test("reports the normalized patterns in order, and exclusions that do nothing", () => {
    const config = resolveMountIgnoreConfig(
      {
        MOUNT_IGNORE: "**/node_modules,!**/node_modules/.bin,!/vendor/node_modules,/workspace/dist",
      },
      "/workspace",
    );
    const info = describeMountIgnore(config);
    expect(info.patterns).toEqual([
      "**/node_modules",
      "!**/node_modules/.bin",
      "!/vendor/node_modules",
      "/dist",
    ]);
    expect(info.ineffectiveExclusions).toEqual(["!**/node_modules/.bin"]);
    expect(info).not.toHaveProperty("paths");
    expect(info.enabled).toBe(true);
    expect(info.root).toBe("/tmp/workspace");
  });

  const enabled = resolveMountIgnoreConfig({ MOUNT_IGNORE: "/node_modules" }, "/workspace");
  const live = { requested: true, negotiated: true, opens: 0, fallbacks: 0 };

  test("reports passthrough active once a local-only file has used it", () => {
    const info = describeMountIgnore(enabled, { ...live, opens: 1284, fallbacks: 2 });
    expect(info.fastPaths).toMatchObject({
      passthrough: true,
      passthroughOpens: 1284,
      passthroughFallbacks: 2,
      writebackCache: false,
    });
  });

  // Each reason below has a different fix, so each gets its own text.
  // An operator should be able to act on the string without reading
  // the source.

  test("says so when no kernel FUSE mount is running", () => {
    const info = describeMountIgnore(enabled);
    expect(info.fastPaths.passthrough).toBe(false);
    expect(info.fastPaths.passthroughReason).toMatch(/no kernel FUSE mount/);
  });

  test("says so when no local-only paths are configured", () => {
    const info = describeMountIgnore(resolveMountIgnoreConfig({}, "/workspace"), live);
    expect(info.fastPaths.passthrough).toBe(false);
    expect(info.fastPaths.passthroughReason).toMatch(/MOUNT_IGNORE/);
  });

  test("says so when it was turned off", () => {
    const info = describeMountIgnore(enabled, { ...live, requested: false, negotiated: false });
    expect(info.fastPaths.passthroughReason).toMatch(/COMPUTERD_FUSE_PASSTHROUGH/);
  });

  test("blames the kernel when it never offered the capability", () => {
    const info = describeMountIgnore(enabled, { ...live, negotiated: false });
    expect(info.fastPaths.passthrough).toBe(false);
    expect(info.fastPaths.passthroughReason).toMatch(/kernel did not offer/);
    expect(info.fastPaths.passthroughReason).toMatch(/6\.9/);
  });

  test("points at privileges and overlayfs when every registration was refused", () => {
    const info = describeMountIgnore(enabled, { ...live, fallbacks: 3 });
    expect(info.fastPaths.passthrough).toBe(false);
    expect(info.fastPaths.passthroughReason).toMatch(/refused every/);
    expect(info.fastPaths.passthroughReason).toMatch(/CAP_SYS_ADMIN/);
    expect(info.fastPaths.passthroughReason).toMatch(/overlayfs/);
  });

  test("distinguishes a negotiated mount that has not opened a local-only file yet", () => {
    const info = describeMountIgnore(enabled, live);
    expect(info.fastPaths.passthrough).toBe(false);
    expect(info.fastPaths.passthroughReason).toMatch(/no local-only file has been opened/);
  });
});
