// Behavioural tests for the plumbing tail against real
// isomorphic-git and memfs. Each operation is small enough that
// asserting on the observable state (oids match, refs move,
// config persists) is more useful than mocking the underlying
// client.

import git from "isomorphic-git";
import { fs as memfs, vol } from "memfs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  catFileWith,
  configGetWith,
  configSetWith,
  hashObjectWith,
  type IsomorphicGitPlumbingClient,
  updateRefWith,
} from "./plumbing.js";

const DIR = "/repo";
const AUTHOR = { name: "t", email: "t@example.test" };
const isogit = git as unknown as IsomorphicGitPlumbingClient;

async function init() {
  await memfs.promises.mkdir(DIR, { recursive: true });
  await git.init({ fs: memfs, dir: DIR, defaultBranch: "main" });
}

describe("hashObjectWith", () => {
  beforeEach(() => vol.reset());

  it("hashes bytes without writing", async () => {
    await init();
    const oid = await hashObjectWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      content: "hello\n",
    });
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    // The object should not exist in the store.
    await expect(git.readBlob({ fs: memfs, dir: DIR, oid })).rejects.toThrow();
  });

  it("writes the blob when write is true", async () => {
    await init();
    const oid = await hashObjectWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      content: "hello\n",
      write: true,
    });
    const { blob } = await git.readBlob({ fs: memfs, dir: DIR, oid });
    expect(new TextDecoder().decode(blob)).toBe("hello\n");
  });

  it("produces the same oid for the same bytes regardless of write", async () => {
    await init();
    const a = await hashObjectWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      content: "same\n",
    });
    const b = await hashObjectWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      content: "same\n",
      write: true,
    });
    expect(a).toBe(b);
  });
});

describe("catFileWith", () => {
  beforeEach(() => vol.reset());

  it("reads a blob's raw bytes by oid", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/a.txt`, "hello\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "a.txt" });
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });
    const head = await git.resolveRef({ fs: memfs, dir: DIR, ref: "HEAD" });
    const { commit } = await git.readCommit({ fs: memfs, dir: DIR, oid: head });
    const tree = commit.tree;
    // Reading the tree as a blob fails; the wrapper falls
    // through to readObject and returns the raw bytes anyway.
    const result = await catFileWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      oid: tree,
    });
    expect(result.oid).toBe(tree);
    // The tree's content is a packed binary string; we just
    // assert there's some payload.
    expect(result.bytes.byteLength).toBeGreaterThan(0);
  });

  it("supports <oid>:<path> via the filepath option", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/a.txt`, "hello\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "a.txt" });
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });
    const head = await git.resolveRef({ fs: memfs, dir: DIR, ref: "HEAD" });
    const result = await catFileWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      oid: head,
      filepath: "a.txt",
    });
    expect(new TextDecoder().decode(result.bytes)).toBe("hello\n");
  });
});

describe("updateRefWith", () => {
  beforeEach(() => vol.reset());

  it("moves a ref to a given oid", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/a.txt`, "v1\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "a.txt" });
    const first = await git.commit({
      fs: memfs,
      dir: DIR,
      message: "first",
      author: AUTHOR,
    });
    await memfs.promises.writeFile(`${DIR}/a.txt`, "v2 longer\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "a.txt" });
    const second = await git.commit({
      fs: memfs,
      dir: DIR,
      message: "second",
      author: AUTHOR,
    });
    // Move main back to first.
    await updateRefWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      ref: "refs/heads/main",
      value: first,
      force: true,
    });
    expect(await git.resolveRef({ fs: memfs, dir: DIR, ref: "main" })).toBe(first);
    // Sanity: second still exists as an object.
    const { commit } = await git.readCommit({ fs: memfs, dir: DIR, oid: second });
    expect(commit.message).toContain("second");
  });
});

describe("configGetWith / configSetWith", () => {
  beforeEach(() => vol.reset());

  it("set + get round-trips a single value", async () => {
    await init();
    await configSetWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      path: "user.email",
      value: "test@example.test",
    });
    expect(await configGetWith({ git: isogit, fs: memfs, dir: DIR, path: "user.email" })).toBe(
      "test@example.test",
    );
  });

  it("unset removes the value", async () => {
    await init();
    await configSetWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      path: "user.email",
      value: "x@y",
    });
    await configSetWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      path: "user.email",
      value: undefined,
    });
    expect(
      await configGetWith({ git: isogit, fs: memfs, dir: DIR, path: "user.email" }),
    ).toBeUndefined();
  });

  it("returns undefined for an unset key", async () => {
    await init();
    expect(
      await configGetWith({ git: isogit, fs: memfs, dir: DIR, path: "user.missing" }),
    ).toBeUndefined();
  });
});
