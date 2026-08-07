// Behavioural tests for `diffWith` against real isomorphic-git +
// the real `diff` package, backed by an in-memory `memfs` volume.
//
// The mocked seam here is the filesystem — `memfs` is functionally
// node:fs and is the same kind of substitute isomorphic-git's own
// test suite uses. Everything else (status-matrix walk, blob
// reading, patch generation, ref resolution) is real code, so the
// assertions are on observable diff output rather than on which
// arguments the wrapper passed to an injected fake.
//
// Each test builds a tiny repo from scratch in `memfs`, runs
// `diffWith` against it, and checks the unified-diff output.

import { createPatch } from "diff";
import git from "isomorphic-git";
import { fs as memfs, vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { diffSummaryWith, diffWith, type IsomorphicGitDiffClient } from "./diff.js";

const DIR = "/repo";
const AUTHOR = { name: "test", email: "test@example.test" };

// isomorphic-git's typings are wider than `IsomorphicGitDiffClient`;
// the cast happens once here so individual tests stay clean.
const isomorphicGit = git as unknown as IsomorphicGitDiffClient;

async function init(): Promise<void> {
  await memfs.promises.mkdir(DIR, { recursive: true });
  await git.init({ fs: memfs, dir: DIR, defaultBranch: "main" });
}

async function commitFile(path: string, content: string, message: string): Promise<string> {
  await memfs.promises.writeFile(`${DIR}/${path}`, content);
  await git.add({ fs: memfs, dir: DIR, filepath: path });
  return git.commit({ fs: memfs, dir: DIR, message, author: AUTHOR });
}

async function stageThenRemove(path: string): Promise<void> {
  await memfs.promises.writeFile(`${DIR}/${path}`, "hello\n");
  await git.add({ fs: memfs, dir: DIR, filepath: path });
  await memfs.promises.unlink(`${DIR}/${path}`);
}

async function runDiff(opts: { ref?: string } = {}): Promise<string> {
  return diffWith({
    git: isomorphicGit,
    fs: memfs,
    createPatch,
    readFile: (path) => memfs.promises.readFile(path) as Promise<Uint8Array | string>,
    dir: DIR,
    ref: opts.ref,
  });
}

describe("diffWith (real isomorphic-git + memfs)", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("returns '' when HEAD cannot be resolved (no commits yet)", async () => {
    await init();
    expect(await runDiff()).toBe("");
  });

  it("returns '' for a staged addition removed from the working tree", async () => {
    await init();
    await commitFile("base.txt", "base\n", "init");
    await stageThenRemove("added.txt");

    expect(await runDiff()).toBe("");
  });

  it("returns '' when the working tree matches HEAD", async () => {
    await init();
    await commitFile("a.txt", "hello\n", "init");
    expect(await runDiff()).toBe("");
  });

  it("emits a unified diff for a modified file", async () => {
    await init();
    await commitFile("a.txt", "hello\n", "init");
    await memfs.promises.writeFile(`${DIR}/a.txt`, "hello world\n");

    const out = await runDiff();
    // Real createPatch output: file header + a hunk with the old
    // line removed and the new line added.
    expect(out).toContain("--- a.txt");
    expect(out).toContain("+++ a.txt");
    expect(out).toContain("-hello");
    expect(out).toContain("+hello world");
  });

  it("emits a diff for an added (untracked) file", async () => {
    await init();
    await commitFile("a.txt", "kept\n", "init");
    await memfs.promises.writeFile(`${DIR}/b.txt`, "new\n");

    const out = await runDiff();
    expect(out).toContain("--- b.txt");
    expect(out).toContain("+new");
    // The untouched file must not appear in the diff.
    expect(out).not.toContain("--- a.txt");
  });

  it("emits a diff for a deleted file", async () => {
    await init();
    await commitFile("gone.txt", "bye\n", "init");
    await memfs.promises.unlink(`${DIR}/gone.txt`);

    const out = await runDiff();
    expect(out).toContain("--- gone.txt");
    expect(out).toContain("-bye");
    expect(out).not.toMatch(/^\+bye/m);
  });

  it("joins diffs for multiple changed files", async () => {
    await init();
    await commitFile("a.txt", "alpha\n", "init a");
    await commitFile("b.txt", "beta\n", "init b");

    await memfs.promises.writeFile(`${DIR}/a.txt`, "alpha v2\n");
    await memfs.promises.writeFile(`${DIR}/b.txt`, "beta v2\n");

    const out = await runDiff();
    expect(out).toContain("--- a.txt");
    expect(out).toContain("--- b.txt");
    expect(out).toContain("+alpha v2");
    expect(out).toContain("+beta v2");
  });

  it("forwards the cache to statusMatrix and readBlob", async () => {
    await init();
    await commitFile("a.txt", "hello\n", "init");
    await memfs.promises.writeFile(`${DIR}/a.txt`, "hello world\n");

    const cache = {};
    const statusSpy = vi.spyOn(git, "statusMatrix");
    const blobSpy = vi.spyOn(git, "readBlob");
    try {
      await diffWith({
        git: isomorphicGit,
        fs: memfs,
        createPatch,
        readFile: (path) => memfs.promises.readFile(path) as Promise<Uint8Array | string>,
        dir: DIR,
        cache,
      });
      // Both passes the *same* cache reference; isomorphic-git
      // mutates it in place, so identity matters more than shape.
      expect(statusSpy.mock.calls[0][0]).toMatchObject({ cache });
      expect(blobSpy.mock.calls[0][0]).toMatchObject({ cache });
    } finally {
      statusSpy.mockRestore();
      blobSpy.mockRestore();
    }
  });

  it("respects the `ref` argument when diffing against an older commit", async () => {
    await init();
    const first = await commitFile("a.txt", "v1\n", "v1");
    await commitFile("a.txt", "v2 longer\n", "v2"); // HEAD is now at v2.

    // Workdir matches HEAD, but differs from `first`. Diffing against
    // HEAD returns "", diffing against `first` returns the v1->v2
    // delta.
    expect(await runDiff()).toBe("");

    const out = await runDiff({ ref: first });
    expect(out).toContain("-v1");
    expect(out).toContain("+v2 longer");
  });
});

describe("diffWith ref-to-ref and path filtering", () => {
  beforeEach(() => vol.reset());

  async function runRefDiff(opts: { ref: string; to: string; paths?: string[] }): Promise<string> {
    return diffWith({
      git: isomorphicGit,
      fs: memfs,
      createPatch,
      readFile: (path) => memfs.promises.readFile(path) as Promise<Uint8Array | string>,
      dir: DIR,
      ref: opts.ref,
      to: opts.to,
      paths: opts.paths,
    });
  }

  it("diffs committed -> committed, ignoring the working tree", async () => {
    await init();
    const first = await commitFile("a.txt", "alpha\n", "v1");
    const second = await commitFile("a.txt", "alpha beta gamma\n", "v2");
    // Workdir matches v2; even with a mid-flight write, ref-to-ref
    // must not look at disk.
    await memfs.promises.writeFile(`${DIR}/a.txt`, "dirty\n");

    const out = await runRefDiff({ ref: first, to: second });
    expect(out).toContain("-alpha");
    expect(out).toContain("+alpha beta gamma");
    expect(out).not.toContain("dirty");
  });

  it("emits added / removed files between commits", async () => {
    await init();
    const first = await commitFile("keep.txt", "keep\n", "v1");
    await memfs.promises.writeFile(`${DIR}/new.txt`, "new\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "new.txt" });
    const second = await git.commit({
      fs: memfs,
      dir: DIR,
      message: "add new",
      author: AUTHOR,
    });

    const out = await diffWith({
      git: isomorphicGit,
      fs: memfs,
      createPatch,
      readFile: (path) => memfs.promises.readFile(path) as Promise<Uint8Array | string>,
      dir: DIR,
      ref: first,
      to: second,
    });
    expect(out).toContain("--- new.txt");
    expect(out).toContain("+new");
    // keep.txt is unchanged between the two commits; must not
    // appear in the diff.
    expect(out).not.toContain("--- keep.txt");
  });

  it("paths restricts the diff to the listed entries", async () => {
    await init();
    await commitFile("keep.txt", "k1\n", "v1");
    await commitFile("drop.txt", "d1\n", "v1d");
    await memfs.promises.writeFile(`${DIR}/keep.txt`, "k2 longer\n");
    await memfs.promises.writeFile(`${DIR}/drop.txt`, "d2 longer\n");

    const out = await diffWith({
      git: isomorphicGit,
      fs: memfs,
      createPatch,
      readFile: (path) => memfs.promises.readFile(path) as Promise<Uint8Array | string>,
      dir: DIR,
      paths: ["keep.txt"],
    });
    expect(out).toContain("--- keep.txt");
    expect(out).not.toContain("--- drop.txt");
  });

  it("paths matches a directory prefix", async () => {
    await init();
    await memfs.promises.mkdir(`${DIR}/src`, { recursive: true });
    await memfs.promises.writeFile(`${DIR}/src/a.txt`, "src1\n");
    await memfs.promises.writeFile(`${DIR}/top.txt`, "top1\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "src/a.txt" });
    await git.add({ fs: memfs, dir: DIR, filepath: "top.txt" });
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });

    await memfs.promises.writeFile(`${DIR}/src/a.txt`, "src2 longer\n");
    await memfs.promises.writeFile(`${DIR}/top.txt`, "top2 longer\n");

    const out = await diffWith({
      git: isomorphicGit,
      fs: memfs,
      createPatch,
      readFile: (path) => memfs.promises.readFile(path) as Promise<Uint8Array | string>,
      dir: DIR,
      paths: ["src"],
    });
    expect(out).toContain("--- src/a.txt");
    expect(out).not.toContain("--- top.txt");
  });
});

describe("diffSummaryWith (real isomorphic-git + memfs)", () => {
  beforeEach(() => vol.reset());

  function summary(opts: { ref?: string; to?: string; paths?: string[] } = {}) {
    return diffSummaryWith({
      git: isomorphicGit,
      fs: memfs,
      createPatch,
      readFile: (path) => memfs.promises.readFile(path) as Promise<Uint8Array | string>,
      dir: DIR,
      ...opts,
    });
  }

  it("returns an empty list for a staged addition removed from the working tree", async () => {
    await init();
    await commitFile("base.txt", "base\n", "init");
    await stageThenRemove("added.txt");

    expect(await summary()).toEqual([]);
  });

  it("returns an empty list for a clean working tree", async () => {
    await init();
    await commitFile("a.txt", "hello\n", "init");
    expect(await summary()).toEqual([]);
  });

  it("reports a modified file with insertion / deletion counts", async () => {
    await init();
    await commitFile("a.txt", "one\ntwo\n", "init");
    await memfs.promises.writeFile(`${DIR}/a.txt`, "one\ntwo\nthree\n");
    const entries = await summary();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: "a.txt", status: "M", insertions: 1, deletions: 0 });
  });

  it("reports an added file", async () => {
    await init();
    await commitFile("a.txt", "kept\n", "init");
    await memfs.promises.writeFile(`${DIR}/b.txt`, "new1\nnew2\n");
    const entries = await summary();
    expect(entries).toEqual([{ path: "b.txt", status: "A", insertions: 2, deletions: 0 }]);
  });

  it("reports an added empty file", async () => {
    await init();
    await commitFile("a.txt", "kept\n", "init");
    await memfs.promises.writeFile(`${DIR}/empty.txt`, "");
    const entries = await summary();
    expect(entries).toEqual([{ path: "empty.txt", status: "A", insertions: 0, deletions: 0 }]);
  });

  it("reports a deleted file", async () => {
    await init();
    await commitFile("gone.txt", "a\nb\n", "init");
    await memfs.promises.unlink(`${DIR}/gone.txt`);
    const entries = await summary();
    expect(entries).toEqual([{ path: "gone.txt", status: "D", insertions: 0, deletions: 2 }]);
  });

  it("reports a deleted empty file", async () => {
    await init();
    await commitFile("empty.txt", "", "init");
    await memfs.promises.unlink(`${DIR}/empty.txt`);
    const entries = await summary();
    expect(entries).toEqual([{ path: "empty.txt", status: "D", insertions: 0, deletions: 0 }]);
  });

  it("reports added and deleted files between two commits", async () => {
    await init();
    const first = await commitFile("keep.txt", "keep\n", "v1");
    await memfs.promises.writeFile(`${DIR}/new.txt`, "x\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "new.txt" });
    const second = await git.commit({ fs: memfs, dir: DIR, message: "add", author: AUTHOR });
    const entries = await summary({ ref: first, to: second });
    expect(entries).toEqual([{ path: "new.txt", status: "A", insertions: 1, deletions: 0 }]);
  });

  it("reports empty file presence changes between two commits", async () => {
    await init();
    const first = await commitFile("removed.txt", "", "v1");
    await memfs.promises.unlink(`${DIR}/removed.txt`);
    await memfs.promises.writeFile(`${DIR}/added.txt`, "");
    await git.remove({ fs: memfs, dir: DIR, filepath: "removed.txt" });
    await git.add({ fs: memfs, dir: DIR, filepath: "added.txt" });
    const second = await git.commit({
      fs: memfs,
      dir: DIR,
      message: "empty changes",
      author: AUTHOR,
    });
    const entries = await summary({ ref: first, to: second });
    expect(entries).toEqual([
      { path: "added.txt", status: "A", insertions: 0, deletions: 0 },
      { path: "removed.txt", status: "D", insertions: 0, deletions: 0 },
    ]);
  });

  it("counts content lines that begin with diff header prefixes", async () => {
    await init();
    await commitFile("patch.txt", "-- old old\n", "v1");
    await memfs.promises.writeFile(`${DIR}/patch.txt`, "++ new\n");
    const entries = await summary();
    expect(entries).toEqual([{ path: "patch.txt", status: "M", insertions: 1, deletions: 1 }]);
  });
});
