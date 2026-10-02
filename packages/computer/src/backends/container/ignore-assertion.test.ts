import { describe, expect, test } from "vitest";

import {
  assertIgnoreMatches,
  ContainerIgnoreMismatchError,
  diffIgnore,
  type ResolvedIgnore,
  readIgnoreReport,
} from "./ignore-assertion.js";

// The failure guarded here is slow rather than loud: a stale or absent
// MOUNT_IGNORE looks exactly like a correct one until a dependency tree
// is written and pulled into the DO. So most of these tests are about
// the check firing, not about it passing.

const supported = (paths: string[]): ResolvedIgnore => ({
  paths,
  root: "/tmp/workspace",
  mountPoint: "/workspace",
  supported: true,
});

describe("readIgnoreReport", () => {
  test("reports paths as absolute container paths under the mount", () => {
    // computerd reports mount-relative; the host wants something it can
    // use against a container path without re-deriving the mount point.
    const resolved = readIgnoreReport({
      backend: { kind: "fuse" },
      mountPoint: "/workspace",
      ignore: {
        supported: true,
        enabled: true,
        root: "/tmp/workspace",
        paths: ["node_modules", "dist"],
        redundant: [],
      },
    });
    expect(resolved).toEqual({
      paths: ["/workspace/node_modules", "/workspace/dist"],
      root: "/tmp/workspace",
      mountPoint: "/workspace",
      supported: true,
    });
  });

  test("treats a computerd with no ignore block as unsupported", () => {
    // The old-image case, and the one most likely to occur in practice.
    // Not a parse error: absence is a meaningful answer.
    const resolved = readIgnoreReport({ backend: { kind: "fuse" }, mountPoint: "/workspace" });
    expect(resolved).toEqual({
      paths: [],
      root: undefined,
      mountPoint: undefined,
      supported: false,
    });
  });

  test("treats a malformed block as unsupported rather than throwing", () => {
    expect(readIgnoreReport({ ignore: null }).supported).toBe(false);
    expect(readIgnoreReport({ ignore: "yes" }).supported).toBe(false);
    expect(readIgnoreReport({ ignore: { supported: false } }).supported).toBe(false);
    expect(readIgnoreReport(null).supported).toBe(false);
    expect(readIgnoreReport(undefined).supported).toBe(false);
  });

  test("defaults paths to empty when the block omits them", () => {
    const resolved = readIgnoreReport({
      mountPoint: "/workspace",
      ignore: { supported: true, root: "/tmp/x" },
    });
    expect(resolved).toEqual({
      paths: [],
      root: "/tmp/x",
      mountPoint: "/workspace",
      supported: true,
    });
  });
});

describe("diffIgnore", () => {
  test("agrees when the sets match", () => {
    expect(diffIgnore(["node_modules", "dist"], ["node_modules", "dist"])).toBeNull();
  });

  test("ignores declaration order", () => {
    // computerd reports in declaration order after dropping redundant
    // entries; a host listing the same paths differently means the same.
    expect(diffIgnore(["dist", "node_modules"], ["node_modules", "dist"])).toBeNull();
  });

  test("ignores slash decoration on either side", () => {
    expect(diffIgnore(["/dist/", "node_modules"], ["dist", "node_modules"])).toBeNull();
  });

  test("collapses duplicates in the declaration", () => {
    // computerd would have collapsed them, so the client must too or
    // every duplicated entry becomes a spurious mismatch.
    expect(diffIgnore(["dist", "dist"], ["dist"])).toBeNull();
  });

  test("reports a path the container does not apply", () => {
    expect(diffIgnore(["node_modules", "dist"], ["node_modules"])).toEqual({
      missing: ["dist"],
      unexpected: [],
    });
  });

  test("reports a path the container applies but the caller did not declare", () => {
    expect(diffIgnore(["node_modules"], ["node_modules", "target"])).toEqual({
      missing: [],
      unexpected: ["target"],
    });
  });

  test("reports both directions at once", () => {
    expect(diffIgnore(["a", "b"], ["b", "c"])).toEqual({ missing: ["a"], unexpected: ["c"] });
  });

  test("an empty declaration against a configured container is a mismatch", () => {
    // Distinct from omitting `ignore` entirely, which skips the check.
    // Declaring "nothing is local-only" against a container that makes
    // node_modules local-only is a real disagreement.
    expect(diffIgnore([], ["node_modules"])).toEqual({
      missing: [],
      unexpected: ["node_modules"],
    });
  });
});

describe("assertIgnoreMatches", () => {
  test("omitting the declaration skips the check", () => {
    // The default. Adopting this option is opt-in, so an existing
    // deployment cannot start failing because a new field appeared.
    expect(() => assertIgnoreMatches(undefined, supported(["node_modules"]))).not.toThrow();
    expect(() =>
      assertIgnoreMatches(undefined, {
        paths: [],
        root: undefined,
        mountPoint: undefined,
        supported: false,
      }),
    ).not.toThrow();
  });

  test("passes when the declaration matches", () => {
    expect(() =>
      assertIgnoreMatches(["node_modules", "dist"], supported(["node_modules", "dist"])),
    ).not.toThrow();
  });

  test("rejects a computerd that does not support the feature", () => {
    // README warns the computerd image can lag the pinned client. An
    // old image would otherwise look like it is working while quietly
    // syncing a full node_modules.
    expect(() =>
      assertIgnoreMatches(["node_modules"], {
        paths: [],
        root: undefined,
        mountPoint: undefined,
        supported: false,
      }),
    ).toThrow(ContainerIgnoreMismatchError);
    expect(() =>
      assertIgnoreMatches(["node_modules"], {
        paths: [],
        root: undefined,
        mountPoint: undefined,
        supported: false,
      }),
    ).toThrow(/does not support local-only paths/);
  });

  test("the unsupported message says what the consequence is", () => {
    // Not just "mismatch". The operator needs to know the paths will be
    // pulled into the DO, which is the expensive part.
    try {
      assertIgnoreMatches(["node_modules"], {
        paths: [],
        root: undefined,
        mountPoint: undefined,
        supported: false,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toMatch(/pulled into the Durable Object/);
      expect((error as Error).message).toMatch(/Upgrade the computerd image/);
    }
  });

  test("names which paths will be synced when the container is missing one", () => {
    try {
      assertIgnoreMatches(["node_modules", "dist"], supported(["node_modules"]));
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/"dist"/);
      expect(message).toMatch(/WILL be synced/);
    }
  });

  test("names which paths will not be synced when the container adds one", () => {
    // The opposite direction is just as dangerous: the caller believes
    // `target` is durable and it is not.
    try {
      assertIgnoreMatches(["node_modules"], supported(["node_modules", "target"]));
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/"target"/);
      expect(message).toMatch(/will NOT be synced/);
    }
  });

  test("points at the setting that overrides `ignore`", () => {
    // `ignore` is passed to the container as MOUNT_IGNORE, so a
    // disagreement means something else set the variable after it.
    try {
      assertIgnoreMatches(["a"], supported(["b"]));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toMatch(/MOUNT_IGNORE in `containerEnv`/);
    }
  });

  test("accepts declarations spelled with the mount point", () => {
    // computerd strips the mount prefix, so "/workspace/dist" and "/dist"
    // configure the same path. Comparing them raw rejects a container
    // that is doing exactly what was asked.
    expect(() =>
      assertIgnoreMatches(
        ["/workspace/dist", "/workspace/node_modules/"],
        supported(["/workspace/dist", "/workspace/node_modules"]),
      ),
    ).not.toThrow();
  });

  test("does not strip a prefix that only looks like the mount point", () => {
    // "/workspacefoo" is not under "/workspace", so it names
    // "/workspace/workspacefoo", not "/workspace/foo".
    expect(() => assertIgnoreMatches(["/workspacefoo"], supported(["/workspace/foo"]))).toThrow(
      ContainerIgnoreMismatchError,
    );
  });

  test("carries the declared and actual sets on the error", () => {
    // So a host can log or reconcile them without parsing the message.
    try {
      assertIgnoreMatches(["a"], supported(["b"]));
      expect.unreachable("should have thrown");
    } catch (error) {
      const mismatch = error as ContainerIgnoreMismatchError;
      expect(mismatch.declared).toEqual(["a"]);
      expect(mismatch.actual).toEqual(["b"]);
      expect(mismatch.supported).toBe(true);
    }
  });
});
