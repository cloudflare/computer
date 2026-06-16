// Behavioural tests for `addWith` and `rmWith`. Drives real
// isomorphic-git + memfs so the index updates are observable
// through subsequent `statusMatrix` rows.

import git from "isomorphic-git";
import { fs as memfs, vol } from "memfs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  addWith,
  type IsomorphicGitAddClient,
  type IsomorphicGitRmClient,
  rmWith,
} from "./staging.js";

const DIR = "/repo";
const AUTHOR = { name: "t", email: "t@example.test" };

async function init() {
  await memfs.promises.mkdir(DIR, { recursive: true });
  await git.init({ fs: memfs, dir: DIR, defaultBranch: "main" });
}

async function statusOf(path: string): Promise<[number, number, number] | undefined> {
  const matrix = await git.statusMatrix({ fs: memfs, dir: DIR });
  const row = matrix.find((r) => r[0] === path);
  if (!row) return undefined;
  return [row[1], row[2], row[3]];
}

describe("addWith", () => {
  beforeEach(() => vol.reset());

  it("stages a single file (workdir == stage after add)", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/a.txt`, "hello\n");
    await addWith({
      git: git as unknown as IsomorphicGitAddClient,
      fs: memfs,
      dir: DIR,
      paths: ["a.txt"],
    });
    // [head=0, workdir=2, stage=2] — added file, identical in workdir and stage.
    expect(await statusOf("a.txt")).toEqual([0, 2, 2]);
  });

  it("stages multiple paths in one call", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/a.txt`, "a\n");
    await memfs.promises.writeFile(`${DIR}/b.txt`, "b\n");
    await addWith({
      git: git as unknown as IsomorphicGitAddClient,
      fs: memfs,
      dir: DIR,
      paths: ["a.txt", "b.txt"],
    });
    expect(await statusOf("a.txt")).toEqual([0, 2, 2]);
    expect(await statusOf("b.txt")).toEqual([0, 2, 2]);
  });

  it("empty paths is a no-op", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/a.txt`, "x\n");
    await addWith({
      git: git as unknown as IsomorphicGitAddClient,
      fs: memfs,
      dir: DIR,
      paths: [],
    });
    // a.txt remains untracked: head=0, workdir=2, stage=0.
    expect(await statusOf("a.txt")).toEqual([0, 2, 0]);
  });

  it("all: true stages new, modified, and deleted paths", async () => {
    await init();
    // Commit a baseline with two files.
    await memfs.promises.writeFile(`${DIR}/keep.txt`, "k1\n");
    await memfs.promises.writeFile(`${DIR}/gone.txt`, "g1\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "keep.txt" });
    await git.add({ fs: memfs, dir: DIR, filepath: "gone.txt" });
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });

    // Modify one, delete one, add one new untracked file.
    await memfs.promises.writeFile(`${DIR}/keep.txt`, "k2 changed\n");
    await memfs.promises.unlink(`${DIR}/gone.txt`);
    await memfs.promises.writeFile(`${DIR}/new.txt`, "n1\n");

    await addWith({
      git: git as unknown as IsomorphicGitAddClient,
      fs: memfs,
      dir: DIR,
      paths: [],
      all: true,
    });

    // Modified file staged: workdir == stage.
    expect(await statusOf("keep.txt")).toEqual([1, 2, 2]);
    // New file staged.
    expect(await statusOf("new.txt")).toEqual([0, 2, 2]);
    // Deleted file unstaged from the index: stage=0.
    expect(await statusOf("gone.txt")).toEqual([1, 0, 0]);
  });

  it("all + trackedOnly stages tracked changes but leaves untracked files alone", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/keep.txt`, "k1\n");
    await memfs.promises.writeFile(`${DIR}/gone.txt`, "g1\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "keep.txt" });
    await git.add({ fs: memfs, dir: DIR, filepath: "gone.txt" });
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });

    await memfs.promises.writeFile(`${DIR}/keep.txt`, "k2 changed\n");
    await memfs.promises.unlink(`${DIR}/gone.txt`);
    await memfs.promises.writeFile(`${DIR}/new.txt`, "n1\n");

    await addWith({
      git: git as unknown as IsomorphicGitAddClient,
      fs: memfs,
      dir: DIR,
      paths: [],
      all: true,
      trackedOnly: true,
    });

    // Tracked modification staged.
    expect(await statusOf("keep.txt")).toEqual([1, 2, 2]);
    // Tracked deletion staged.
    expect(await statusOf("gone.txt")).toEqual([1, 0, 0]);
    // Untracked file left unstaged: head=0, workdir=2, stage=0.
    expect(await statusOf("new.txt")).toEqual([0, 2, 0]);
  });
});

describe("rmWith", () => {
  beforeEach(() => vol.reset());

  it("removes a previously-committed path from the index", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/gone.txt`, "bye\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "gone.txt" });
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });
    await rmWith({
      git: git as unknown as IsomorphicGitRmClient,
      fs: memfs,
      dir: DIR,
      paths: ["gone.txt"],
    });
    // The file is gone from the index (stage=0). isomorphic-git's
    // `remove` only unstages — the working tree copy still exists.
    // workdirStatus reads 1 ("== HEAD") because the file on disk
    // still matches what HEAD recorded.
    expect(await statusOf("gone.txt")).toEqual([1, 1, 0]);
  });
});
