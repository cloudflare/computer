// Behavioural tests for the working-tree family: stash, reset,
// and clean. Drives real isomorphic-git + memfs so index and
// working-tree effects are observable.

import git from "isomorphic-git";
import { fs as memfs, vol } from "memfs";
import { beforeEach, describe, expect, it } from "vitest";

import { NotARepositoryError } from "./errors.js";
import {
  cleanWith,
  type IsomorphicGitCleanClient,
  type IsomorphicGitResetClient,
  type IsomorphicGitStashClient,
  resetWith,
  stashListWith,
  stashPopWith,
  stashPushWith,
} from "./worktree.js";

const DIR = "/repo";
const AUTHOR = { name: "t", email: "t@example.test" };

const stashClient = git as unknown as IsomorphicGitStashClient;
const resetClient = git as unknown as IsomorphicGitResetClient;

async function init() {
  await memfs.promises.mkdir(DIR, { recursive: true });
  await git.init({ fs: memfs, dir: DIR, defaultBranch: "main" });
  // stash creates a commit internally, so it needs an identity.
  await git.setConfig({ fs: memfs, dir: DIR, path: "user.name", value: AUTHOR.name });
  await git.setConfig({ fs: memfs, dir: DIR, path: "user.email", value: AUTHOR.email });
}

async function commit(name: string, content: string, message: string): Promise<string> {
  await memfs.promises.writeFile(`${DIR}/${name}`, content);
  await git.add({ fs: memfs, dir: DIR, filepath: name });
  return git.commit({ fs: memfs, dir: DIR, message, author: AUTHOR });
}

async function statusOf(path: string): Promise<[number, number, number] | undefined> {
  const matrix = await git.statusMatrix({ fs: memfs, dir: DIR });
  const row = matrix.find((r) => r[0] === path);
  return row ? [row[1], row[2], row[3]] : undefined;
}

describe("stashPushWith / stashListWith / stashPopWith", () => {
  beforeEach(() => vol.reset());

  it("stashes tracked modifications and restores a clean tree", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    await memfs.promises.writeFile(`${DIR}/a.txt`, "v2 dirty\n");

    await stashPushWith({ git: stashClient, fs: memfs, dir: DIR, message: "wip" });

    // Working tree is back to the committed content.
    expect(await memfs.promises.readFile(`${DIR}/a.txt`, "utf8")).toBe("v1\n");
  });

  it("lists stash entries newest-first", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    await memfs.promises.writeFile(`${DIR}/a.txt`, "v2\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "a.txt" });
    await stashPushWith({ git: stashClient, fs: memfs, dir: DIR, message: "first" });

    const list = await stashListWith({ git: stashClient, fs: memfs, dir: DIR });
    expect(list).toHaveLength(1);
    expect(list[0]).toContain("first");
  });

  it("pops the latest stash back into the working tree", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    await memfs.promises.writeFile(`${DIR}/a.txt`, "v2 dirty\n");
    await stashPushWith({ git: stashClient, fs: memfs, dir: DIR });

    await stashPopWith({ git: stashClient, fs: memfs, dir: DIR });
    expect(await memfs.promises.readFile(`${DIR}/a.txt`, "utf8")).toBe("v2 dirty\n");
  });

  it("stash push surfaces a non-repo as an error", async () => {
    await memfs.promises.mkdir("/loose", { recursive: true });
    await expect(stashPushWith({ git: stashClient, fs: memfs, dir: "/loose" })).rejects.toThrow();
  });
});

describe("resetWith", () => {
  beforeEach(() => vol.reset());

  it("unstages a path (path reset against HEAD)", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    await memfs.promises.writeFile(`${DIR}/a.txt`, "v2\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "a.txt" });
    // Staged modification: [head=1, workdir=2, stage=2].
    expect(await statusOf("a.txt")).toEqual([1, 2, 2]);

    await resetWith({ git: resetClient, fs: memfs, dir: DIR, paths: ["a.txt"] });
    // Unstaged: stage back to matching HEAD (workdir still differs).
    expect(await statusOf("a.txt")).toEqual([1, 2, 1]);
  });

  it("hard reset restores tracked files to HEAD", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    await memfs.promises.writeFile(`${DIR}/a.txt`, "v2 dirty\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "a.txt" });

    await resetWith({ git: resetClient, fs: memfs, dir: DIR, hard: true });
    expect(await memfs.promises.readFile(`${DIR}/a.txt`, "utf8")).toBe("v1\n");
    // Back to clean: head == workdir == stage.
    expect(await statusOf("a.txt")).toEqual([1, 1, 1]);
  });

  it("hard reset works from detached HEAD", async () => {
    await init();
    const first = await commit("a.txt", "v1\n", "first");
    const second = await commit("a.txt", "v2\n", "second");
    await git.checkout({ fs: memfs, dir: DIR, ref: second });
    expect(await git.currentBranch({ fs: memfs, dir: DIR })).toBeUndefined();
    await memfs.promises.writeFile(`${DIR}/a.txt`, "dirty\n");

    await resetWith({ git: resetClient, fs: memfs, dir: DIR, hard: true, ref: first });

    expect(await git.resolveRef({ fs: memfs, dir: DIR, ref: "HEAD" })).toBe(first);
    expect(await git.currentBranch({ fs: memfs, dir: DIR })).toBeUndefined();
    expect(await memfs.promises.readFile(`${DIR}/a.txt`, "utf8")).toBe("v1\n");
    expect(await statusOf("a.txt")).toEqual([1, 1, 1]);
  });

  it("hard reset throws NotARepositoryError outside a repo", async () => {
    await memfs.promises.mkdir("/loose", { recursive: true });
    await expect(
      resetWith({ git: resetClient, fs: memfs, dir: "/loose", hard: true }),
    ).rejects.toBeInstanceOf(NotARepositoryError);
  });
});

describe("cleanWith", () => {
  beforeEach(() => vol.reset());

  const cleanClient = git as unknown as IsomorphicGitCleanClient;

  it("dry run lists untracked files without removing them", async () => {
    await init();
    await commit("tracked.txt", "t\n", "init");
    await memfs.promises.writeFile(`${DIR}/junk.txt`, "j\n");

    const removed = await cleanWith({
      git: cleanClient,
      fs: memfs,
      dir: DIR,
      directories: true,
      dryRun: true,
    });
    expect(removed).toEqual(["junk.txt"]);
    // Still on disk.
    expect(await memfs.promises.readFile(`${DIR}/junk.txt`, "utf8")).toBe("j\n");
  });

  it("removes untracked files and directories", async () => {
    await init();
    await commit("tracked.txt", "t\n", "init");
    await memfs.promises.writeFile(`${DIR}/junk.txt`, "j\n");
    await memfs.promises.mkdir(`${DIR}/build`, { recursive: true });
    await memfs.promises.writeFile(`${DIR}/build/out.o`, "o\n");

    const removed = await cleanWith({
      git: cleanClient,
      fs: memfs,
      dir: DIR,
      directories: true,
    });
    expect(removed.sort()).toEqual(["build", "junk.txt"]);
    await expect(memfs.promises.stat(`${DIR}/junk.txt`)).rejects.toThrow();
    await expect(memfs.promises.stat(`${DIR}/build`)).rejects.toThrow();
    // Tracked file untouched.
    expect(await memfs.promises.readFile(`${DIR}/tracked.txt`, "utf8")).toBe("t\n");
  });

  it("leaves untracked directories alone without directories: true", async () => {
    await init();
    await commit("tracked.txt", "t\n", "init");
    await memfs.promises.mkdir(`${DIR}/build`, { recursive: true });
    await memfs.promises.writeFile(`${DIR}/build/out.o`, "o\n");
    await memfs.promises.writeFile(`${DIR}/junk.txt`, "j\n");

    const removed = await cleanWith({ git: cleanClient, fs: memfs, dir: DIR });
    expect(removed).toEqual(["junk.txt"]);
    // Directory survives.
    expect(await memfs.promises.stat(`${DIR}/build`)).toBeTruthy();
  });
});
