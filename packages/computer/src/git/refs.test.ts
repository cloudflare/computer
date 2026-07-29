// Behavioural tests for branch / tag / checkout against real
// isomorphic-git and memfs. The wrappers are thin, so the
// assertions focus on the observable state — which refs exist
// after each call, where HEAD points, and what's on disk after
// a path-scoped checkout — rather than on which arguments
// reached isomorphic-git.

import git from "isomorphic-git";
import { fs as memfs, vol } from "memfs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  branchDeleteWith,
  branchListWith,
  branchWith,
  checkoutWith,
  type IsomorphicGitRefsClient,
  tagDeleteWith,
  tagListWith,
  tagWith,
} from "./refs.js";

const DIR = "/repo";
const AUTHOR = { name: "t", email: "t@example.test" };
const isogit = git as unknown as IsomorphicGitRefsClient;

async function init() {
  await memfs.promises.mkdir(DIR, { recursive: true });
  await git.init({ fs: memfs, dir: DIR, defaultBranch: "main" });
}

async function commit(path: string, content: string, message: string): Promise<string> {
  await memfs.promises.writeFile(`${DIR}/${path}`, content);
  await git.add({ fs: memfs, dir: DIR, filepath: path });
  return git.commit({ fs: memfs, dir: DIR, message, author: AUTHOR });
}

describe("branchWith", () => {
  beforeEach(() => vol.reset());

  it("creates a branch at HEAD by default", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    await branchWith({ git: isogit, fs: memfs, dir: DIR, name: "feature" });
    const branches = await branchListWith({ git: isogit, fs: memfs, dir: DIR });
    expect(branches.sort()).toEqual(["feature", "main"]);
  });

  it("creates a branch at a specific start point", async () => {
    await init();
    const first = await commit("a.txt", "v1\n", "first");
    await commit("a.txt", "v2 longer\n", "second");
    await branchWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      name: "old",
      startPoint: first,
    });
    const oid = await git.resolveRef({ fs: memfs, dir: DIR, ref: "old" });
    expect(oid).toBe(first);
  });

  it("force overwrites an existing branch", async () => {
    await init();
    const first = await commit("a.txt", "v1\n", "first");
    const second = await commit("a.txt", "v2 longer\n", "second");
    await branchWith({ git: isogit, fs: memfs, dir: DIR, name: "feature", startPoint: first });
    await branchWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      name: "feature",
      startPoint: second,
      force: true,
    });
    const oid = await git.resolveRef({ fs: memfs, dir: DIR, ref: "feature" });
    expect(oid).toBe(second);
  });
});

describe("branchDeleteWith", () => {
  beforeEach(() => vol.reset());

  it("removes a branch from the listing", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    await branchWith({ git: isogit, fs: memfs, dir: DIR, name: "feature" });
    await branchDeleteWith({ git: isogit, fs: memfs, dir: DIR, name: "feature" });
    const branches = await branchListWith({ git: isogit, fs: memfs, dir: DIR });
    expect(branches).toEqual(["main"]);
  });
});

describe("tagWith / tagDeleteWith / tagListWith", () => {
  beforeEach(() => vol.reset());

  it("creates and lists a lightweight tag", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    await tagWith({ git: isogit, fs: memfs, dir: DIR, name: "v1.0" });
    expect(await tagListWith({ git: isogit, fs: memfs, dir: DIR })).toEqual(["v1.0"]);
  });

  it("tags a specific commit", async () => {
    await init();
    const first = await commit("a.txt", "v1\n", "first");
    await commit("a.txt", "v2 longer\n", "second");
    await tagWith({ git: isogit, fs: memfs, dir: DIR, name: "first", object: first });
    const oid = await git.resolveRef({ fs: memfs, dir: DIR, ref: "first" });
    expect(oid).toBe(first);
  });

  it("deletes a tag", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    await tagWith({ git: isogit, fs: memfs, dir: DIR, name: "v1.0" });
    await tagDeleteWith({ git: isogit, fs: memfs, dir: DIR, name: "v1.0" });
    expect(await tagListWith({ git: isogit, fs: memfs, dir: DIR })).toEqual([]);
  });
});

describe("checkoutWith", () => {
  beforeEach(() => vol.reset());

  it("moves HEAD to a named branch", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    await branchWith({ git: isogit, fs: memfs, dir: DIR, name: "feature" });
    await checkoutWith({ git: isogit, fs: memfs, dir: DIR, ref: "feature" });
    const current = await git.currentBranch({ fs: memfs, dir: DIR });
    expect(current).toBe("feature");
  });

  it("path-scoped checkout updates the working tree but not HEAD", async () => {
    await init();
    await commit("a.txt", "v1\n", "first");
    await commit("a.txt", "v2 longer\n", "second");
    const headBefore = await git.resolveRef({ fs: memfs, dir: DIR, ref: "HEAD" });

    // Resolve "first" so we restore the older content of a.txt
    // without moving HEAD off "second".
    const first = (await git.log({ fs: memfs, dir: DIR })).find((c) =>
      c.commit.message.includes("first"),
    )?.oid;
    if (!first) throw new Error("could not resolve `first`");

    await checkoutWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      ref: first,
      paths: ["a.txt"],
      force: true,
    });
    expect(await memfs.promises.readFile(`${DIR}/a.txt`, "utf8")).toBe("v1\n");
    const headAfter = await git.resolveRef({ fs: memfs, dir: DIR, ref: "HEAD" });
    expect(headAfter).toBe(headBefore);
  });
});
