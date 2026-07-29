// Behavioural tests for `commitWith` against real isomorphic-git +
// memfs. Identity resolution lives in this module; the precedence
// (explicit → env → defaultIdentity) is the headline contract.

import git from "isomorphic-git";
import { fs as memfs, vol } from "memfs";
import { beforeEach, describe, expect, it } from "vitest";

import { commitWith, type IsomorphicGitCommitClient } from "./commit.js";
import { MissingIdentityError } from "./errors.js";

const DIR = "/repo";

async function init() {
  await memfs.promises.mkdir(DIR, { recursive: true });
  await git.init({ fs: memfs, dir: DIR, defaultBranch: "main" });
}

async function stage(name: string, content: string) {
  await memfs.promises.writeFile(`${DIR}/${name}`, content);
  await git.add({ fs: memfs, dir: DIR, filepath: name });
}

async function readHead(): Promise<{
  author: { name: string; email: string };
  committer: { name: string; email: string };
}> {
  const oid = await git.resolveRef({ fs: memfs, dir: DIR, ref: "HEAD" });
  const { commit } = await git.readCommit({ fs: memfs, dir: DIR, oid });
  return commit;
}

const isogit = git as unknown as IsomorphicGitCommitClient;

describe("commitWith identity resolution", () => {
  beforeEach(() => vol.reset());

  it("uses explicit options.author when provided", async () => {
    await init();
    await stage("a.txt", "hi\n");
    const { oid } = await commitWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      message: "init",
      author: { name: "Alice", email: "a@x" },
    });
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    const head = await readHead();
    expect(head.author).toMatchObject({ name: "Alice", email: "a@x" });
  });

  it("falls back to env GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL", async () => {
    await init();
    await stage("a.txt", "hi\n");
    await commitWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      message: "init",
      env: { GIT_AUTHOR_NAME: "Bob", GIT_AUTHOR_EMAIL: "b@x" },
    });
    const head = await readHead();
    expect(head.author).toMatchObject({ name: "Bob", email: "b@x" });
  });

  it("reads user.name / user.email from local config when env is absent", async () => {
    await init();
    await git.setConfig({ fs: memfs, dir: DIR, path: "user.name", value: "Config User" });
    await git.setConfig({ fs: memfs, dir: DIR, path: "user.email", value: "cfg@x" });
    await stage("a.txt", "hi\n");
    await commitWith({ git: isogit, fs: memfs, dir: DIR, message: "init" });
    const head = await readHead();
    expect(head.author).toMatchObject({ name: "Config User", email: "cfg@x" });
  });

  it("prefers env over local config", async () => {
    await init();
    await git.setConfig({ fs: memfs, dir: DIR, path: "user.name", value: "Config User" });
    await git.setConfig({ fs: memfs, dir: DIR, path: "user.email", value: "cfg@x" });
    await stage("a.txt", "hi\n");
    await commitWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      message: "init",
      env: { GIT_AUTHOR_NAME: "Env User", GIT_AUTHOR_EMAIL: "env@x" },
    });
    const head = await readHead();
    expect(head.author).toMatchObject({ name: "Env User", email: "env@x" });
  });

  it("prefers local config over defaultIdentity", async () => {
    await init();
    await git.setConfig({ fs: memfs, dir: DIR, path: "user.name", value: "Config User" });
    await git.setConfig({ fs: memfs, dir: DIR, path: "user.email", value: "cfg@x" });
    await stage("a.txt", "hi\n");
    await commitWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      message: "init",
      defaultIdentity: { name: "Default", email: "d@x" },
    });
    const head = await readHead();
    expect(head.author).toMatchObject({ name: "Config User", email: "cfg@x" });
  });

  it("falls back to defaultIdentity when env and config are absent", async () => {
    await init();
    await stage("a.txt", "hi\n");
    await commitWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      message: "init",
      defaultIdentity: { name: "Default", email: "d@x" },
    });
    const head = await readHead();
    expect(head.author).toMatchObject({ name: "Default", email: "d@x" });
  });

  it("throws MissingIdentityError when no source yields an identity", async () => {
    await init();
    await stage("a.txt", "hi\n");
    await expect(
      commitWith({ git: isogit, fs: memfs, dir: DIR, message: "init" }),
    ).rejects.toBeInstanceOf(MissingIdentityError);
  });

  it("explicit options.committer overrides the resolved author for the committer field", async () => {
    await init();
    await stage("a.txt", "hi\n");
    await commitWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      message: "init",
      author: { name: "Alice", email: "a@x" },
      committer: { name: "CI", email: "ci@x" },
    });
    const head = await readHead();
    expect(head.committer).toMatchObject({ name: "CI", email: "ci@x" });
    expect(head.author).toMatchObject({ name: "Alice", email: "a@x" });
  });
});

describe("commitWith", () => {
  beforeEach(() => vol.reset());

  it("empty message is rejected", async () => {
    await init();
    await stage("a.txt", "hi\n");
    await expect(
      commitWith({
        git: isogit,
        fs: memfs,
        dir: DIR,
        message: "   ",
        author: { name: "A", email: "a@x" },
      }),
    ).rejects.toThrow(/message is required/);
  });
});
