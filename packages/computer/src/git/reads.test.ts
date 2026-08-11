// Behavioural tests for the read-only family: log, show,
// revParse, currentBranch, lsFiles, lsTree. Each is a thin
// wrapper around isomorphic-git; the headline contract is
// "structured output matches what the CLI dispatcher will then
// format". We drive real isomorphic-git + memfs throughout.

import git from "isomorphic-git";
import { fs as memfs, vol } from "memfs";
import { beforeEach, describe, expect, it } from "vitest";

import { NotARepositoryError } from "./errors.js";
import {
  currentBranchWith,
  type IsomorphicGitReadsClient,
  logWith,
  lsFilesWith,
  lsTreeWith,
  repoRootWith,
  revParseWith,
  showWith,
} from "./reads.js";

const DIR = "/repo";
const AUTHOR = { name: "t", email: "t@example.test" };
const isogit = git as unknown as IsomorphicGitReadsClient;

async function init() {
  await memfs.promises.mkdir(DIR, { recursive: true });
  await git.init({ fs: memfs, dir: DIR, defaultBranch: "main" });
}

async function commit(path: string, content: string, message: string): Promise<string> {
  await memfs.promises.writeFile(`${DIR}/${path}`, content);
  await git.add({ fs: memfs, dir: DIR, filepath: path });
  return git.commit({ fs: memfs, dir: DIR, message, author: AUTHOR });
}

describe("logWith", () => {
  beforeEach(() => vol.reset());

  it("walks commits in newest-first order", async () => {
    await init();
    const first = await commit("a.txt", "v1\n", "first");
    const second = await commit("a.txt", "v2 longer\n", "second");
    const commits = await logWith({ git: isogit, fs: memfs, dir: DIR });
    expect(commits.map((c) => c.oid)).toEqual([second, first]);
    expect(commits[0].message).toContain("second");
  });

  it("honours depth", async () => {
    await init();
    await commit("a.txt", "v1\n", "first");
    await commit("a.txt", "v2 longer\n", "second");
    const commits = await logWith({ git: isogit, fs: memfs, dir: DIR, depth: 1 });
    expect(commits).toHaveLength(1);
  });

  it("throws NotARepositoryError when dir has no .git", async () => {
    await memfs.promises.mkdir("/no-repo", { recursive: true });
    await expect(logWith({ git: isogit, fs: memfs, dir: "/no-repo" })).rejects.toBeInstanceOf(
      NotARepositoryError,
    );
  });
});

describe("showWith", () => {
  beforeEach(() => vol.reset());

  it("reads a commit by ref", async () => {
    await init();
    const oid = await commit("a.txt", "v1\n", "init");
    const c = await showWith({ git: isogit, fs: memfs, dir: DIR, ref: "HEAD" });
    expect(c.oid).toBe(oid);
    expect(c.message).toContain("init");
    expect(c.author).toMatchObject({ name: "t", email: "t@example.test" });
  });

  it("reads a commit by oid", async () => {
    await init();
    const oid = await commit("a.txt", "v1\n", "init");
    const c = await showWith({ git: isogit, fs: memfs, dir: DIR, ref: oid });
    expect(c.oid).toBe(oid);
  });
});

describe("revParseWith", () => {
  beforeEach(() => vol.reset());

  it("resolves HEAD to its oid", async () => {
    await init();
    const oid = await commit("a.txt", "v1\n", "init");
    const out = await revParseWith({ git: isogit, fs: memfs, dir: DIR, ref: "HEAD" });
    expect(out).toBe(oid);
  });

  it("resolves a branch name", async () => {
    await init();
    const oid = await commit("a.txt", "v1\n", "init");
    const out = await revParseWith({ git: isogit, fs: memfs, dir: DIR, ref: "main" });
    expect(out).toBe(oid);
  });

  it("resolves an abbreviated oid", async () => {
    await init();
    const oid = await commit("a.txt", "v1\n", "init");
    const out = await revParseWith({ git: isogit, fs: memfs, dir: DIR, ref: oid.slice(0, 7) });
    expect(out).toBe(oid);
  });

  it("resolves an uppercase abbreviated oid", async () => {
    await init();
    const oid = await commit("a.txt", "v1\n", "init");
    const out = await revParseWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      ref: oid.slice(0, 7).toUpperCase(),
    });
    expect(out).toBe(oid);
  });

  it("resolves an abbreviated oid with an ancestry suffix", async () => {
    await init();
    const first = await commit("a.txt", "v1\n", "first");
    const second = await commit("a.txt", "v2\n", "second");
    const out = await revParseWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      ref: `${second.slice(0, 7)}^`,
    });
    expect(out).toBe(first);
  });

  it("prefers an exact hexadecimal ref over an abbreviated oid", async () => {
    await init();
    const oid = await commit("a.txt", "v1\n", "first");
    const short = oid.slice(0, 7);
    const refOid = await commit("a.txt", "v2\n", "second");
    await git.branch({ fs: memfs, dir: DIR, ref: short, object: refOid });
    const out = await revParseWith({ git: isogit, fs: memfs, dir: DIR, ref: short });
    expect(out).toBe(refOid);
  });

  it("does not expand a missing non-hexadecimal ref", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    await expect(
      revParseWith({ git: isogit, fs: memfs, dir: DIR, ref: "missing-branch" }),
    ).rejects.toMatchObject({ code: "EREVPARSEFAIL" });
  });

  it("preserves ambiguity errors for abbreviated oids", async () => {
    const ambiguous = Object.assign(new Error("ambiguous"), { code: "AmbiguousError" });
    const client = {
      resolveRef: async () => {
        throw Object.assign(new Error("not found"), { code: "NotFoundError" });
      },
      expandOid: async () => {
        throw ambiguous;
      },
    } as unknown as IsomorphicGitReadsClient;
    await expect(
      revParseWith({ git: client, fs: memfs, dir: DIR, ref: "abcdef0" }),
    ).rejects.toMatchObject({ code: "EREVPARSEFAIL", cause: ambiguous });
  });

  it("resolves HEAD^ to the first parent", async () => {
    await init();
    const first = await commit("a.txt", "v1\n", "first");
    await commit("a.txt", "v2\n", "second");
    const out = await revParseWith({ git: isogit, fs: memfs, dir: DIR, ref: "HEAD^" });
    expect(out).toBe(first);
  });

  it("resolves HEAD~1 to the first parent", async () => {
    await init();
    const first = await commit("a.txt", "v1\n", "first");
    await commit("a.txt", "v2\n", "second");
    const out = await revParseWith({ git: isogit, fs: memfs, dir: DIR, ref: "HEAD~1" });
    expect(out).toBe(first);
  });

  it("resolves HEAD~2 two commits back", async () => {
    await init();
    const first = await commit("a.txt", "v1\n", "first");
    await commit("a.txt", "v2\n", "second");
    await commit("a.txt", "v3\n", "third");
    const out = await revParseWith({ git: isogit, fs: memfs, dir: DIR, ref: "HEAD~2" });
    expect(out).toBe(first);
  });

  it("resolves a branch name with a suffix", async () => {
    await init();
    const first = await commit("a.txt", "v1\n", "first");
    await commit("a.txt", "v2\n", "second");
    const out = await revParseWith({ git: isogit, fs: memfs, dir: DIR, ref: "main~1" });
    expect(out).toBe(first);
  });

  it("throws when walking past the root commit", async () => {
    await init();
    await commit("a.txt", "v1\n", "only");
    await expect(
      revParseWith({ git: isogit, fs: memfs, dir: DIR, ref: "HEAD~5" }),
    ).rejects.toThrow();
  });
});

describe("currentBranchWith", () => {
  beforeEach(() => vol.reset());

  it("returns the branch name on the default checkout", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    expect(await currentBranchWith({ git: isogit, fs: memfs, dir: DIR })).toBe("main");
  });

  it("returns the full ref name with fullname: true", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    expect(await currentBranchWith({ git: isogit, fs: memfs, dir: DIR, fullname: true })).toBe(
      "refs/heads/main",
    );
  });
});

describe("repoRootWith", () => {
  beforeEach(() => vol.reset());

  it("returns the repo root from the root dir itself", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    expect(await repoRootWith({ fs: memfs, dir: DIR })).toBe(DIR);
  });

  it("finds the repo root from a nested subdirectory", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    await memfs.promises.mkdir(`${DIR}/deep/nested`, { recursive: true });
    expect(await repoRootWith({ fs: memfs, dir: `${DIR}/deep/nested` })).toBe(DIR);
  });

  it("throws NotARepositoryError outside any repo", async () => {
    await memfs.promises.mkdir("/loose", { recursive: true });
    await expect(repoRootWith({ fs: memfs, dir: "/loose" })).rejects.toBeInstanceOf(
      NotARepositoryError,
    );
  });
});

describe("lsFilesWith", () => {
  beforeEach(() => vol.reset());

  it("lists files in the index", async () => {
    await init();
    await commit("a.txt", "x\n", "init a");
    await commit("b.txt", "y\n", "init b");
    const out = await lsFilesWith({ git: isogit, fs: memfs, dir: DIR });
    expect(out.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("lists files at a given ref", async () => {
    await init();
    const first = await commit("a.txt", "x\n", "init a");
    await commit("b.txt", "y\n", "init b");
    const out = await lsFilesWith({ git: isogit, fs: memfs, dir: DIR, ref: first });
    expect(out).toEqual(["a.txt"]);
  });
});

describe("lsTreeWith", () => {
  beforeEach(() => vol.reset());

  it("lists the root of a tree", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/a.txt`, "x\n");
    await memfs.promises.mkdir(`${DIR}/sub`);
    await memfs.promises.writeFile(`${DIR}/sub/b.txt`, "y\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "a.txt" });
    await git.add({ fs: memfs, dir: DIR, filepath: "sub/b.txt" });
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });
    const entries = await lsTreeWith({ git: isogit, fs: memfs, dir: DIR, ref: "HEAD" });
    const byPath = new Map(entries.map((e) => [e.path, e]));
    expect(byPath.get("a.txt")?.type).toBe("blob");
    expect(byPath.get("sub")?.type).toBe("tree");
  });

  it("lists a sub-tree by path", async () => {
    await init();
    await memfs.promises.mkdir(`${DIR}/sub`, { recursive: true });
    await memfs.promises.writeFile(`${DIR}/sub/b.txt`, "y\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "sub/b.txt" });
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });
    const entries = await lsTreeWith({
      git: isogit,
      fs: memfs,
      dir: DIR,
      ref: "HEAD",
      path: "sub",
    });
    expect(entries.map((e) => e.path)).toEqual(["b.txt"]);
    expect(entries[0].type).toBe("blob");
  });
});
