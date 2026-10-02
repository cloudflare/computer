import { describe, expect, test } from "vitest";

import { MountIgnorePathError, parseMountIgnore, resolveMountIgnore } from "./ignore.js";

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

const MOUNT = "/workspace";
const set = (patterns: string[]) => resolveMountIgnore(patterns, MOUNT);

describe("resolveMountIgnore: matching", () => {
  test("an anchored pattern matches its path and everything under it", () => {
    const ignore = set(["/node_modules"]);
    expect(ignore.ignores("node_modules")).toBe(true);
    expect(ignore.ignores("node_modules/react/index.js")).toBe(true);
    expect(ignore.ignores("app/node_modules")).toBe(false);
  });

  test("** matches at any depth, including the root", () => {
    const ignore = set(["**/node_modules"]);
    expect(ignore.ignores("node_modules")).toBe(true);
    expect(ignore.ignores("app/node_modules")).toBe(true);
    expect(ignore.ignores("a/b/c/d/e/node_modules/x/index.js")).toBe(true);
    expect(ignore.ignores("src/main.ts")).toBe(false);
  });

  test("matches whole segments, so node_modules_extra is not node_modules", () => {
    // A naive suffix or prefix test passes most of this file and fails here.
    const ignore = set(["**/node_modules", "/dist"]);
    expect(ignore.ignores("node_modules_extra")).toBe(false);
    expect(ignore.ignores("a/node_modules_extra/x")).toBe(false);
    expect(ignore.ignores("a/my_node_modules")).toBe(false);
    expect(ignore.ignores("dist2")).toBe(false);
  });

  test("* matches within one segment and never crosses /", () => {
    const ignore = set(["/packages/*/dist"]);
    expect(ignore.ignores("packages/a/dist")).toBe(true);
    expect(ignore.ignores("packages/a/dist/index.js")).toBe(true);
    expect(ignore.ignores("packages/a/b/dist")).toBe(false);
    expect(ignore.ignores("packages/dist")).toBe(false);
  });

  test("* can sit inside a segment", () => {
    const ignore = set(["**/*.tsbuildinfo"]);
    expect(ignore.ignores("tsconfig.tsbuildinfo")).toBe(true);
    expect(ignore.ignores("a/b/x.tsbuildinfo")).toBe(true);
    expect(ignore.ignores("a/b/x.tsbuildinfo.bak")).toBe(false);
  });

  test("** in the middle matches zero or more directories", () => {
    const ignore = set(["/app/**/node_modules"]);
    expect(ignore.ignores("app/node_modules")).toBe(true);
    expect(ignore.ignores("app/a/b/node_modules")).toBe(true);
    expect(ignore.ignores("node_modules")).toBe(false);
    expect(ignore.ignores("web/node_modules")).toBe(false);
  });

  test("a trailing /** means the directory itself", () => {
    const ignore = set(["/cache/**"]);
    expect(ignore.ignores("cache")).toBe(true);
    expect(ignore.ignores("cache/a/b")).toBe(true);
    expect(ignore.ignores("cached")).toBe(false);
  });

  test("treats regular expression characters in a pattern literally", () => {
    const ignore = set(["**/a.b+c(d)"]);
    expect(ignore.ignores("x/a.b+c(d)")).toBe(true);
    expect(ignore.ignores("x/aXb+c(d)")).toBe(false);
  });

  test("matches case-sensitively, as Linux does", () => {
    expect(set(["**/node_modules"]).ignores("Node_Modules")).toBe(false);
  });

  test("tolerates leading and trailing slashes on the queried path", () => {
    const ignore = set(["/dist"]);
    expect(ignore.ignores("/dist/")).toBe(true);
    expect(ignore.ignores("")).toBe(false);
    expect(ignore.ignores("/")).toBe(false);
  });

  test("ignores nothing when no patterns are configured", () => {
    const ignore = set([]);
    expect(ignore.isEmpty).toBe(true);
    expect(ignore.ignores("node_modules")).toBe(false);
  });
});

describe("resolveMountIgnore: exclusions", () => {
  test("an exclusion at the level of the match keeps that path synced", () => {
    const ignore = set(["**/node_modules", "!/vendor/node_modules"]);
    expect(ignore.ignores("vendor/node_modules")).toBe(false);
    expect(ignore.ignores("vendor/node_modules/pkg/index.js")).toBe(false);
    expect(ignore.ignores("app/node_modules")).toBe(true);
    expect(ignore.ignores("node_modules")).toBe(true);
  });

  test("an exclusion under a local-only directory has no effect", () => {
    // The parent lives on local disk, so the synced filesystem has no
    // directory for the excluded child to live in. Same rule as git.
    const ignore = set(["**/node_modules", "!**/node_modules/.bin"]);
    expect(ignore.ignores("a/node_modules/.bin")).toBe(true);
    expect(ignore.ignores("a/node_modules/.bin/tool")).toBe(true);
  });

  test("the last matching pattern wins", () => {
    const ignore = set(["**/build", "!/tools/build", "/tools/build/out"]);
    expect(ignore.ignores("app/build")).toBe(true);
    expect(ignore.ignores("tools/build")).toBe(false);
    expect(ignore.ignores("tools/build/src.ts")).toBe(false);
    expect(ignore.ignores("tools/build/out/a.js")).toBe(true);
  });

  test("an ignore after an exclusion wins again", () => {
    const ignore = set(["!/dist", "/dist"]);
    expect(ignore.ignores("dist")).toBe(true);
  });

  test("exclusions alone ignore nothing", () => {
    const ignore = set(["!/vendor/node_modules"]);
    expect(ignore.isEmpty).toBe(true);
    expect(ignore.ignores("vendor/node_modules")).toBe(false);
  });

  test("checks a wildcard exclusion against what its wildcard could match", () => {
    const ignore = set(["/build-*", "!/build-*/keep"]);
    expect(ignore.ineffectiveExclusions).toEqual(["!/build-*/keep"]);
  });

  test("reports exclusions that cannot take effect", () => {
    const ignore = set([
      "**/node_modules",
      "!**/node_modules/.bin",
      "!/app/node_modules/keep",
      "!/vendor/node_modules",
    ]);
    expect(ignore.ineffectiveExclusions).toEqual([
      "!**/node_modules/.bin",
      "!/app/node_modules/keep",
    ]);
  });
});

describe("resolveMountIgnore: normalization", () => {
  test("keeps patterns in the order written", () => {
    // Order changes the meaning once exclusions are involved.
    expect(set(["**/node_modules", "!/vendor/node_modules", "/dist"]).patterns).toEqual([
      "**/node_modules",
      "!/vendor/node_modules",
      "/dist",
    ]);
  });

  test("strips the mount point from a fully-qualified pattern", () => {
    expect(set(["/workspace/dist", "!/workspace/vendor/node_modules"]).patterns).toEqual([
      "/dist",
      "!/vendor/node_modules",
    ]);
  });

  test("does not strip a prefix that only looks like the mount point", () => {
    expect(set(["/workspacefoo"]).patterns).toEqual(["/workspacefoo"]);
  });

  test("strips trailing slashes", () => {
    expect(set(["/dist/", "**/node_modules/"]).patterns).toEqual(["/dist", "**/node_modules"]);
  });

  test("writes a leading /** as **", () => {
    expect(set(["/**/node_modules"]).patterns).toEqual(["**/node_modules"]);
  });

  test("leaves the mount point alone when it is /", () => {
    const ignore = resolveMountIgnore(["/workspace/dist"], "/");
    expect(ignore.patterns).toEqual(["/workspace/dist"]);
    expect(ignore.ignores("workspace/dist")).toBe(true);
  });
});

describe("resolveMountIgnore: rejected patterns", () => {
  const rejects = (pattern: string, message: RegExp) => {
    expect(() => set([pattern])).toThrow(MountIgnorePathError);
    expect(() => set([pattern])).toThrow(message);
  };

  test("requires every pattern to start with / or **/", () => {
    // node_modules alone means root-only here and any depth in gitignore.
    // Rejecting it means nobody has to remember which.
    rejects("node_modules", /must start with "\/" .* or "\*\*\/"/);
    rejects("*/dist", /must start with/);
    rejects("!vendor/node_modules", /must start with/);
  });

  test("suggests both anchored spellings", () => {
    rejects("node_modules", /"\/node_modules" or "\*\*\/node_modules"/);
  });

  test("requires ** to be a whole segment", () => {
    rejects("**node_modules", /must start with/);
    rejects("/a**/b", /"\*\*" must be a whole path segment/);
    rejects("/a/b**", /"\*\*" must be a whole path segment/);
  });

  test("rejects patterns that would make the whole mount local-only", () => {
    for (const pattern of ["/", "**", "/**", "**/**", "/workspace", "/workspace/**", "!/**"]) {
      rejects(pattern, /whole mount/);
    }
  });

  test("rejects wildcards that match every path at some depth", () => {
    // "/*" matches every top-level entry, and everything under a
    // local-only directory is local-only, so nothing would sync.
    for (const pattern of ["/*", "/**/*", "**/*", "/*/*", "/*/**", "!/*"]) {
      rejects(pattern, /whole mount/);
    }
  });

  test("still accepts targeted wildcards", () => {
    expect(() => set(["/*.log", "/packages/*/dist", "**/*.tsbuildinfo", "/build-*"])).not.toThrow();
  });

  test("rejects . and .. segments", () => {
    rejects("/a/../b", /"\." or "\.\." segment/);
    rejects("/./a", /"\." or "\.\." segment/);
    rejects("**/..", /"\." or "\.\." segment/);
  });

  test("rejects an empty segment", () => {
    rejects("/a//b", /empty path segment/);
  });

  test("rejects syntax that is not supported, rather than matching it literally", () => {
    for (const pattern of ["/*.{js,ts}", "/[ab]", "/a?", "/a\\*"]) {
      rejects(pattern, /not supported/);
    }
  });

  test("rejects an empty exclusion", () => {
    rejects("!", /must start with/);
  });

  test("bounds pattern length", () => {
    rejects(`/${"a".repeat(5000)}`, /longer than 4096/);
  });

  test("reports the index so a long MOUNT_IGNORE is diagnosable", () => {
    try {
      set(["/dist", "/ok", "bad"]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MountIgnorePathError);
      expect((error as MountIgnorePathError).index).toBe(2);
      expect((error as MountIgnorePathError).entry).toBe("bad");
    }
  });
});
