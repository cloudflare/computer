import { describe, expect, test } from "vitest";

import { MountIgnorePathError, parseMountIgnore, resolveMountIgnore } from "./ignore.js";

// A naive `startsWith` passes every other test in this file and fails
// "does not treat node_modules_extra as node_modules", so that test is
// what actually pins the matcher.

describe("parseMountIgnore", () => {
  test("splits MOUNT_IGNORE on commas", () => {
    expect(parseMountIgnore("/node_modules,/.venv,/dist")).toEqual([
      "/node_modules",
      "/.venv",
      "/dist",
    ]);
  });

  test("tolerates whitespace around entries", () => {
    expect(parseMountIgnore("/node_modules , /dist")).toEqual(["/node_modules", "/dist"]);
  });

  test("skips empty fields from a trailing or doubled comma", () => {
    expect(parseMountIgnore("/dist,,/node_modules,")).toEqual(["/dist", "/node_modules"]);
  });

  test("keeps entries containing spaces intact", () => {
    expect(parseMountIgnore("/my dir,/dist")).toEqual(["/my dir", "/dist"]);
  });

  test("treats an absent or empty value as the feature being off", () => {
    expect(parseMountIgnore(undefined)).toEqual([]);
    expect(parseMountIgnore("")).toEqual([]);
    expect(parseMountIgnore(" , ,  ")).toEqual([]);
  });
});

describe("resolveMountIgnore: matching", () => {
  test("matches the entry itself and everything under it", () => {
    const set = resolveMountIgnore(["node_modules"]);
    expect(set.ignores("node_modules")).toBe(true);
    expect(set.ignores("node_modules/react")).toBe(true);
    expect(set.ignores("node_modules/react/index.js")).toBe(true);
    expect(set.ignores("node_modules/@scope/pkg/dist/x.js")).toBe(true);
  });

  test("does not match at arbitrary depth", () => {
    // The deliberate limitation. `node_modules` names one location;
    // a nested one must be listed explicitly.
    const set = resolveMountIgnore(["node_modules"]);
    expect(set.ignores("app/node_modules")).toBe(false);
    expect(set.ignores("a/b/node_modules")).toBe(false);
  });

  test("matches a nested entry when it is listed", () => {
    const set = resolveMountIgnore(["app/node_modules", "web/node_modules"]);
    expect(set.ignores("app/node_modules")).toBe(true);
    expect(set.ignores("app/node_modules/react/index.js")).toBe(true);
    expect(set.ignores("web/node_modules")).toBe(true);
    expect(set.ignores("api/node_modules")).toBe(false);
    expect(set.ignores("node_modules")).toBe(false);
  });

  test("does not treat node_modules_extra as node_modules", () => {
    // A plain startsWith check passes everything above and fails here.
    const set = resolveMountIgnore(["node_modules"]);
    expect(set.ignores("node_modules_extra")).toBe(false);
    expect(set.ignores("node_modules_extra/x.js")).toBe(false);
    expect(set.ignores("node_modulesX")).toBe(false);
  });

  test("does not match a prefix of an entry", () => {
    const set = resolveMountIgnore(["build/output"]);
    expect(set.ignores("build")).toBe(false);
    expect(set.ignores("build/output")).toBe(true);
    expect(set.ignores("build/output/app.js")).toBe(true);
    expect(set.ignores("build/outputs")).toBe(false);
  });

  test("matches case-sensitively, as Linux does", () => {
    const set = resolveMountIgnore(["node_modules"]);
    expect(set.ignores("node_modules")).toBe(true);
    expect(set.ignores("Node_Modules")).toBe(false);
  });

  test("tolerates leading and trailing slashes on the queried path", () => {
    const set = resolveMountIgnore(["dist"]);
    expect(set.ignores("/dist")).toBe(true);
    expect(set.ignores("dist/")).toBe(true);
    expect(set.ignores("/dist/app.js")).toBe(true);
  });

  test("ignores nothing when no entries are configured", () => {
    const set = resolveMountIgnore([]);
    expect(set.ignores("node_modules")).toBe(false);
    expect(set.isEmpty).toBe(true);
    expect(set.paths).toEqual([]);
  });

  test("reports the covering entry, for diagnostics and error messages", () => {
    const set = resolveMountIgnore(["node_modules", "target"]);
    expect(set.entryFor("node_modules/react/index.js")).toBe("node_modules");
    expect(set.entryFor("target/debug/app")).toBe("target");
    expect(set.entryFor("src/main.ts")).toBeUndefined();
  });
});

describe("resolveMountIgnore: normalization", () => {
  test("strips leading and trailing slashes from entries", () => {
    const set = resolveMountIgnore(["/dist/", "node_modules/"]);
    expect(set.paths).toEqual(["dist", "node_modules"]);
    expect(set.ignores("dist/app.js")).toBe(true);
  });

  test("accepts an absolute path inside the mount point", () => {
    const set = resolveMountIgnore(["/workspace/dist"], "/workspace");
    expect(set.paths).toEqual(["dist"]);
    expect(set.ignores("dist/app.js")).toBe(true);
  });

  test("anchors a leading slash at the mount root, not the filesystem root", () => {
    // "/node_modules" means $MOUNT_POINT/node_modules. A path that looks
    // like it names somewhere else on disk is still mount-relative, so
    // the entry set can never reach outside the mount.
    const set = resolveMountIgnore(["/etc/passwd"], "/workspace");
    expect(set.paths).toEqual(["etc/passwd"]);
    expect(set.ignores("etc/passwd")).toBe(true);
  });

  test("accepts the fully-qualified form of the same path", () => {
    const set = resolveMountIgnore(["/workspace/dist", "/dist"], "/workspace");
    expect(set.paths).toEqual(["dist"]);
  });

  test("rejects a .. segment rather than resolving it", () => {
    // Silently clamping would hide the mistake behind a path that looks
    // intentional.
    expect(() => resolveMountIgnore(["../escape"])).toThrow(MountIgnorePathError);
    expect(() => resolveMountIgnore(["dist/../../etc"])).toThrow(/"\." or "\.\."/);
  });

  test("rejects a . segment", () => {
    expect(() => resolveMountIgnore(["./dist"])).toThrow(MountIgnorePathError);
  });

  test("rejects an entry naming the mount root", () => {
    // Ignoring everything would make the workspace entirely non-durable,
    // which is never what someone means.
    expect(() => resolveMountIgnore(["/"])).toThrow(MountIgnorePathError);
    expect(() => resolveMountIgnore([""])).toThrow(MountIgnorePathError);
  });

  test("rejects an empty path segment", () => {
    expect(() => resolveMountIgnore(["a//b"])).toThrow(MountIgnorePathError);
  });

  test("reports the entry index so a long MOUNT_IGNORE is diagnosable", () => {
    try {
      resolveMountIgnore(["ok", "also-ok", "../bad"]);
      expect.unreachable("resolve should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MountIgnorePathError);
      expect((error as MountIgnorePathError).index).toBe(2);
      expect((error as MountIgnorePathError).entry).toBe("../bad");
    }
  });
});

describe("resolveMountIgnore: redundancy", () => {
  test("drops a duplicate entry", () => {
    const set = resolveMountIgnore(["dist", "dist"]);
    expect(set.paths).toEqual(["dist"]);
    expect(set.redundant).toEqual(["dist"]);
  });

  test("drops an entry nested inside an earlier one", () => {
    // Keeping node_modules/.cache alongside node_modules would imply it
    // does something, and it cannot.
    const set = resolveMountIgnore(["node_modules", "node_modules/.cache"]);
    expect(set.paths).toEqual(["node_modules"]);
    expect(set.redundant).toEqual(["node_modules/.cache"]);
    expect(set.ignores("node_modules/.cache/x")).toBe(true);
  });

  test("subsumes earlier entries when a broader one arrives later", () => {
    const set = resolveMountIgnore(["app/node_modules", "app"]);
    expect(set.paths).toEqual(["app"]);
    expect(set.redundant).toEqual(["app/node_modules"]);
    expect(set.ignores("app/node_modules/react")).toBe(true);
    expect(set.ignores("app/src/main.ts")).toBe(true);
  });

  test("keeps siblings that merely share a prefix string", () => {
    // `dist` and `dist-types` are unrelated locations despite the
    // common prefix; neither is redundant.
    const set = resolveMountIgnore(["dist", "dist-types"]);
    expect(set.paths).toEqual(["dist", "dist-types"]);
    expect(set.redundant).toEqual([]);
  });

  test("normalizes before deduplicating", () => {
    const set = resolveMountIgnore(["/dist/", "dist"]);
    expect(set.paths).toEqual(["dist"]);
    expect(set.redundant).toEqual(["dist"]);
  });
});
