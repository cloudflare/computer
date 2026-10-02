import { describe, expect, test } from "vitest";

import {
  assertIgnoreMatches,
  ContainerIgnoreMismatchError,
  checkIgnorePatterns,
  type ResolvedIgnore,
  readIgnoreReport,
} from "./ignore-assertion.js";

// The failure guarded here is slow rather than loud: a container that
// isn't applying the patterns looks exactly like one that is until a
// dependency tree is written and pulled into the Durable Object. So most
// of these tests are about the check firing, not about it passing.

const supported = (patterns: string[]): ResolvedIgnore => ({
  patterns,
  root: "/tmp/workspace",
  mountPoint: "/workspace",
  supported: true,
});

const unsupported: ResolvedIgnore = {
  patterns: [],
  root: undefined,
  mountPoint: undefined,
  supported: false,
};

describe("readIgnoreReport", () => {
  test("reports patterns as computerd wrote them", () => {
    // Patterns, not paths: "**/node_modules" can't be joined onto the
    // mount point, so they're passed through untouched.
    const resolved = readIgnoreReport({
      backend: { kind: "fuse" },
      mountPoint: "/workspace",
      ignore: {
        supported: true,
        enabled: true,
        root: "/tmp/workspace",
        patterns: ["**/node_modules", "!/vendor/node_modules", "/dist"],
        ineffectiveExclusions: [],
      },
    });
    expect(resolved).toEqual({
      patterns: ["**/node_modules", "!/vendor/node_modules", "/dist"],
      root: "/tmp/workspace",
      mountPoint: "/workspace",
      supported: true,
    });
  });

  test("treats a computerd with no ignore block as unsupported", () => {
    // The old-image case, and the one most likely to occur in practice.
    // Not a parse error: absence is a meaningful answer.
    expect(readIgnoreReport({ backend: { kind: "fuse" }, mountPoint: "/workspace" })).toEqual(
      unsupported,
    );
  });

  test("treats a computerd that reports paths instead of patterns as unsupported", () => {
    // A computerd from before patterns reports plain `paths` and would
    // reject or misread "**/node_modules".
    expect(
      readIgnoreReport({
        mountPoint: "/workspace",
        ignore: { supported: true, root: "/tmp/workspace", paths: ["node_modules"] },
      }),
    ).toEqual(unsupported);
  });

  test("treats a malformed block as unsupported rather than throwing", () => {
    expect(readIgnoreReport({ ignore: null }).supported).toBe(false);
    expect(readIgnoreReport({ ignore: "yes" }).supported).toBe(false);
    expect(readIgnoreReport({ ignore: { supported: false } }).supported).toBe(false);
    expect(readIgnoreReport({ ignore: { supported: true, patterns: [1] } }).supported).toBe(false);
    expect(readIgnoreReport(null).supported).toBe(false);
    expect(readIgnoreReport(undefined).supported).toBe(false);
  });
});

describe("checkIgnorePatterns", () => {
  // The same cases computerd rejects, so a typo fails before a container
  // starts rather than as a daemon that exits during startup.
  const rejects = (pattern: string, message: RegExp) => {
    expect(() => checkIgnorePatterns([pattern])).toThrow(message);
  };

  test("accepts anchored patterns and exclusions", () => {
    expect(() =>
      checkIgnorePatterns([
        "/dist",
        "/workspace/dist",
        "**/node_modules",
        "/packages/*/dist",
        "/app/**/node_modules",
        "**/*.tsbuildinfo",
        "!/vendor/node_modules",
        "/dist/",
      ]),
    ).not.toThrow();
  });

  test("requires every pattern to start with / or **/", () => {
    rejects("node_modules", /"\/node_modules" or "\*\*\/node_modules"/);
    rejects("*/dist", /must start with/);
    rejects("!vendor/node_modules", /must start with/);
    rejects("!", /must start with/);
    rejects("**node_modules", /must start with/);
  });

  test("requires ** to be a whole segment", () => {
    rejects("/a**/b", /whole path segment/);
  });

  test("rejects patterns that would make the whole mount local-only", () => {
    for (const pattern of ["/", "**", "/**", "**/**", "!/**"]) {
      rejects(pattern, /whole mount/);
    }
  });

  test("rejects wildcards that match every path at some depth", () => {
    for (const pattern of ["/*", "/**/*", "**/*", "/*/*", "/*/**", "!/*"]) {
      rejects(pattern, /whole mount/);
    }
  });

  test("still accepts targeted wildcards", () => {
    expect(() =>
      checkIgnorePatterns(["/*.log", "/packages/*/dist", "**/*.tsbuildinfo", "/build-*"]),
    ).not.toThrow();
  });

  test("rejects . and .. segments, and empty segments", () => {
    rejects("/a/../b", /"\." or "\.\." segment/);
    rejects("/./a", /"\." or "\.\." segment/);
    rejects("/a//b", /empty path segment/);
  });

  test("rejects unsupported syntax", () => {
    for (const pattern of ["/*.{js,ts}", "/[ab]", "/a?", "/a\\*"]) {
      rejects(pattern, /not supported/);
    }
  });

  test("rejects a comma, which would split into two patterns", () => {
    rejects("/a,/b", /comma/);
  });

  test("bounds pattern length", () => {
    rejects(`/${"a".repeat(5000)}`, /longer than 4096/);
  });
});

describe("assertIgnoreMatches", () => {
  test("omitting the declaration skips the check", () => {
    // The default. Adopting this option is opt-in, so an existing
    // deployment cannot start failing because a new field appeared.
    expect(() => assertIgnoreMatches(undefined, supported(["/node_modules"]))).not.toThrow();
    expect(() => assertIgnoreMatches(undefined, unsupported)).not.toThrow();
  });

  test("passes when the declaration matches", () => {
    expect(() =>
      assertIgnoreMatches(
        ["**/node_modules", "!/vendor/node_modules"],
        supported(["**/node_modules", "!/vendor/node_modules"]),
      ),
    ).not.toThrow();
  });

  test("compares declarations in computerd's normalized spelling", () => {
    // computerd strips the mount point and trailing slashes and writes a
    // leading /** as **, so these all configure what it reports.
    expect(() =>
      assertIgnoreMatches(
        ["/workspace/dist/", "!/workspace/vendor/node_modules", "/**/node_modules"],
        supported(["/dist", "!/vendor/node_modules", "**/node_modules"]),
      ),
    ).not.toThrow();
  });

  test("does not strip a prefix that only looks like the mount point", () => {
    expect(() => assertIgnoreMatches(["/workspacefoo"], supported(["/foo"]))).toThrow(
      ContainerIgnoreMismatchError,
    );
  });

  test("a reordered list is a mismatch", () => {
    // With exclusions, order changes the meaning: this pair keeps
    // vendor/node_modules synced one way round and local-only the other.
    expect(() =>
      assertIgnoreMatches(
        ["**/node_modules", "!/vendor/node_modules"],
        supported(["!/vendor/node_modules", "**/node_modules"]),
      ),
    ).toThrow(/same patterns in a different order/);
  });

  test("rejects a computerd that does not support patterns", () => {
    // An old image would otherwise look like it is working while quietly
    // syncing a full node_modules.
    try {
      assertIgnoreMatches(["**/node_modules"], unsupported);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ContainerIgnoreMismatchError);
      const message = (error as Error).message;
      expect(message).toMatch(/does not support MOUNT_IGNORE patterns/);
      expect(message).toMatch(/pulled into the Durable Object/);
      expect(message).toMatch(/Upgrade the computerd image/);
    }
  });

  test("names patterns the container is not applying", () => {
    try {
      assertIgnoreMatches(["**/node_modules", "/dist"], supported(["**/node_modules"]));
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/"\/dist"/);
      expect(message).toMatch(/declared but not applied/);
    }
  });

  test("names patterns the container applies that were not declared", () => {
    try {
      assertIgnoreMatches(["**/node_modules"], supported(["**/node_modules", "/target"]));
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/"\/target"/);
      expect(message).toMatch(/applied by the container but not declared/);
    }
  });

  test("an empty declaration against a configured container is a mismatch", () => {
    // Distinct from omitting `ignore`, which skips the check.
    expect(() => assertIgnoreMatches([], supported(["**/node_modules"]))).toThrow(
      ContainerIgnoreMismatchError,
    );
  });

  test("points at the setting that overrides `ignore`", () => {
    try {
      assertIgnoreMatches(["/a"], supported(["/b"]));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toMatch(/MOUNT_IGNORE in `containerEnv`/);
    }
  });

  test("carries the declared and actual lists on the error", () => {
    // So a host can log or reconcile them without parsing the message.
    try {
      assertIgnoreMatches(["/a"], supported(["/b"]));
      expect.unreachable("should have thrown");
    } catch (error) {
      const mismatch = error as ContainerIgnoreMismatchError;
      expect(mismatch.declared).toEqual(["/a"]);
      expect(mismatch.actual).toEqual(["/b"]);
      expect(mismatch.supported).toBe(true);
    }
  });
});
