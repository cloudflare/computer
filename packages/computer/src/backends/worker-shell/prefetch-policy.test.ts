// When should the shell open a directory-prefetch scope?
//
// Prefetching is only a win for commands that walk a subtree. Opening
// a scope for a command that touches one file wastes a full subtree
// read, so the policy has to be conservative in both directions:
// engage for recursive traversals, stay out of the way otherwise.

import { describe, expect, it } from "vitest";

import { prefetchRootFor } from "./prefetch-policy.js";

describe("prefetchRootFor", () => {
  const cwd = "/w";

  it("engages for a recursive grep", () => {
    expect(prefetchRootFor("grep -rn NEEDLE .", cwd)).toBe("/w");
    expect(prefetchRootFor("grep -r NEEDLE src", cwd)).toBe("/w/src");
    expect(prefetchRootFor("grep -R NEEDLE /abs", cwd)).toBe("/abs");
  });

  it("engages for find", () => {
    expect(prefetchRootFor("find .", cwd)).toBe("/w");
    expect(prefetchRootFor("find src -name '*.ts'", cwd)).toBe("/w/src");
    expect(prefetchRootFor("find /abs -type f", cwd)).toBe("/abs");
  });

  it("defaults find with no path operand to the cwd", () => {
    expect(prefetchRootFor("find -name '*.ts'", cwd)).toBe("/w");
  });

  it("stays out of the way for a non-recursive grep", () => {
    expect(prefetchRootFor("grep NEEDLE file.txt", cwd)).toBeUndefined();
  });

  it("stays out of the way for unrelated commands", () => {
    expect(prefetchRootFor("cat file.txt", cwd)).toBeUndefined();
    expect(prefetchRootFor("ls -la", cwd)).toBeUndefined();
    expect(prefetchRootFor("echo hello", cwd)).toBeUndefined();
    expect(prefetchRootFor("", cwd)).toBeUndefined();
  });

  it("engages when a traversal appears anywhere in a pipeline", () => {
    expect(prefetchRootFor("find . -name '*.ts' | head -5", cwd)).toBe("/w");
    expect(prefetchRootFor("ls && grep -r NEEDLE src", cwd)).toBe("/w/src");
  });

  it("prefers the shallowest root when several traversals appear", () => {
    // Two traversals in one line: the scope has to cover both, so the
    // common ancestor is the safe choice.
    expect(prefetchRootFor("grep -r A src; grep -r B lib", cwd)).toBe("/w");
    expect(prefetchRootFor("grep -r A src/x; grep -r B src/y", cwd)).toBe("/w/src");
  });

  it("does not engage for a command that only writes", () => {
    expect(prefetchRootFor("rm -rf node_modules", cwd)).toBeUndefined();
    expect(prefetchRootFor("cp -r a b", cwd)).toBeUndefined();
  });

  it("skips traversals that mutate, where a snapshot could mislead", () => {
    // -delete and -exec change the tree mid-walk; a cached listing
    // would describe entries that no longer exist.
    expect(prefetchRootFor("find . -name '*.log' -delete", cwd)).toBeUndefined();
    expect(prefetchRootFor("find . -exec rm {} ;", cwd)).toBeUndefined();
  });

  it("ignores flag arguments when picking the start path", () => {
    expect(prefetchRootFor("grep -r --color NEEDLE src", cwd)).toBe("/w/src");
    expect(prefetchRootFor("find src -maxdepth 2 -name x", cwd)).toBe("/w/src");
  });

  it("normalises relative traversal roots", () => {
    expect(prefetchRootFor("find ./src/../lib", cwd)).toBe("/w/lib");
    expect(prefetchRootFor("grep -r NEEDLE ..", cwd)).toBe("/");
  });
});
