// Behavioural tests for `initWith` against real isomorphic-git +
// memfs. Same pattern as clone.test.ts / diff.test.ts: the
// filesystem is the only mocked seam.

import git from "isomorphic-git";
import { fs as memfs, vol } from "memfs";
import { beforeEach, describe, expect, it } from "vitest";

import { AlreadyInitializedError } from "./errors.js";
import { type IsomorphicGitInitClient, initWith } from "./init.js";

const isogit = git as unknown as IsomorphicGitInitClient;

describe("initWith (real isomorphic-git + memfs)", () => {
  beforeEach(() => vol.reset());

  it("creates a .git directory at `dir`", async () => {
    await memfs.promises.mkdir("/repo", { recursive: true });
    await initWith({ git: isogit, fs: memfs, dir: "/repo" });
    const st = await memfs.promises.stat("/repo/.git");
    expect(st.isDirectory()).toBe(true);
  });

  it("defaults the initial branch to main", async () => {
    await memfs.promises.mkdir("/repo", { recursive: true });
    await initWith({ git: isogit, fs: memfs, dir: "/repo" });
    const head = await memfs.promises.readFile("/repo/.git/HEAD", "utf8");
    expect(head).toContain("refs/heads/main");
  });

  it("honours an explicit defaultBranch", async () => {
    await memfs.promises.mkdir("/repo", { recursive: true });
    await initWith({
      git: isogit,
      fs: memfs,
      dir: "/repo",
      defaultBranch: "develop",
    });
    const head = await memfs.promises.readFile("/repo/.git/HEAD", "utf8");
    expect(head).toContain("refs/heads/develop");
  });

  it("throws AlreadyInitializedError if .git already exists", async () => {
    await memfs.promises.mkdir("/repo", { recursive: true });
    await initWith({ git: isogit, fs: memfs, dir: "/repo" });
    await expect(initWith({ git: isogit, fs: memfs, dir: "/repo" })).rejects.toBeInstanceOf(
      AlreadyInitializedError,
    );
  });

  it("a bare repo populates dir directly with no working tree", async () => {
    await memfs.promises.mkdir("/bare", { recursive: true });
    await initWith({ git: isogit, fs: memfs, dir: "/bare", bare: true });
    // Bare repos lay HEAD and refs/ at the top level.
    const head = await memfs.promises.readFile("/bare/HEAD", "utf8");
    expect(head).toContain("refs/heads/main");
    await expect(memfs.promises.stat("/bare/.git")).rejects.toThrow();
  });
});
