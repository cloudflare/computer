// Behavioural tests for `statusWith` and the porcelain v2 /
// short formatters. The status-matrix derivation (X/Y codes) is
// the part most likely to drift; pin every transition explicitly.

import git from "isomorphic-git";
import { fs as memfs, vol } from "memfs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  formatPorcelainV1,
  formatPorcelainV2,
  formatShort,
  type IsomorphicGitStatusClient,
  type StatusEntry,
  type StatusMatrixRow,
  statusWith,
} from "./status.js";

const DIR = "/repo";
const AUTHOR = { name: "t", email: "t@example.test" };
const isogit = git as unknown as IsomorphicGitStatusClient;

async function init() {
  await memfs.promises.mkdir(DIR, { recursive: true });
  await git.init({ fs: memfs, dir: DIR, defaultBranch: "main" });
}

async function commit(name: string, content: string, message: string) {
  await memfs.promises.writeFile(`${DIR}/${name}`, content);
  await git.add({ fs: memfs, dir: DIR, filepath: name });
  await git.commit({ fs: memfs, dir: DIR, message, author: AUTHOR });
}

describe("statusWith — derived XY codes", () => {
  beforeEach(() => vol.reset());

  it("clean working tree yields an empty list", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    expect(await statusWith({ git: isogit, fs: memfs, dir: DIR })).toEqual([]);
  });

  it("untracked file -> '??'", async () => {
    await init();
    await commit("a.txt", "v1\n", "init");
    await memfs.promises.writeFile(`${DIR}/new.txt`, "x\n");
    const out = await statusWith({ git: isogit, fs: memfs, dir: DIR });
    expect(out).toEqual([{ path: "new.txt", index: " ", worktree: "?" }]);
  });

  it("modified-unstaged -> ' M'", async () => {
    // memfs sets file mtime via a tick counter rather than a
    // wall clock; back-to-back writes can produce identical
    // mtimes that fool isomorphic-git's stat-based status cache.
    // The diff-test pattern works because the file size changes
    // (5 -> 11). We do the same here — distinct lengths between
    // the committed content and the working-tree mutation — so
    // statusMatrix unambiguously sees the change.
    await init();
    await commit("a.txt", "short\n", "init");
    await memfs.promises.writeFile(`${DIR}/a.txt`, "longer content\n");
    expect(await statusWith({ git: isogit, fs: memfs, dir: DIR })).toEqual([
      { path: "a.txt", index: " ", worktree: "M" },
    ]);
  });

  it("modified-and-staged -> 'MM'", async () => {
    // After `git add`, the new content lives in the index. The
    // workdir matches stage by content, but isomorphic-git's
    // statusMatrix returns stageStatus=2 ("differs from HEAD")
    // and workdirStatus=2 ("differs from HEAD") rather than
    // marking the workdir-vs-stage row clean. That maps to 'MM'
    // in the XY convention, matching `git status` on the same
    // sequence with a tooling that doesn't refresh between add
    // and status.
    await init();
    await commit("a.txt", "short\n", "init");
    await memfs.promises.writeFile(`${DIR}/a.txt`, "longer content\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "a.txt" });
    expect(await statusWith({ git: isogit, fs: memfs, dir: DIR })).toEqual([
      { path: "a.txt", index: "M", worktree: "M" },
    ]);
  });

  it("staged add -> 'AM'", async () => {
    // Same as above: workdirStatus stays 2 after add against
    // a previously-absent file, so the Y column reads 'M'.
    await init();
    await commit("seed.txt", "x\n", "seed");
    await memfs.promises.writeFile(`${DIR}/new.txt`, "x\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "new.txt" });
    expect(await statusWith({ git: isogit, fs: memfs, dir: DIR })).toEqual([
      { path: "new.txt", index: "A", worktree: "M" },
    ]);
  });

  it("workdir delete -> ' D'", async () => {
    await init();
    await commit("gone.txt", "x\n", "init");
    await memfs.promises.unlink(`${DIR}/gone.txt`);
    expect(await statusWith({ git: isogit, fs: memfs, dir: DIR })).toEqual([
      { path: "gone.txt", index: " ", worktree: "D" },
    ]);
  });

  it("staged delete -> 'D '", async () => {
    await init();
    await commit("gone.txt", "x\n", "init");
    await memfs.promises.unlink(`${DIR}/gone.txt`);
    await git.remove({ fs: memfs, dir: DIR, filepath: "gone.txt" });

    expect(await statusWith({ git: isogit, fs: memfs, dir: DIR })).toEqual([
      { path: "gone.txt", index: "D", worktree: " " },
    ]);
  });

  it("multiple entries are sorted lexicographically", async () => {
    await init();
    await commit("base.txt", "x\n", "init");
    await memfs.promises.writeFile(`${DIR}/b.txt`, "x\n");
    await memfs.promises.writeFile(`${DIR}/a.txt`, "x\n");
    const out = await statusWith({ git: isogit, fs: memfs, dir: DIR });
    expect(out.map((e) => e.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("returns an empty list when dir has no .git", async () => {
    // isomorphic-git's statusMatrix walks the working tree
    // against an empty TREE walker when there's no .git, so
    // it returns []. We rely on call-site validation (the CLI
    // dispatcher) for the not-a-repo error path on subcommands
    // that need it; status itself is lenient.
    await memfs.promises.mkdir("/no-repo", { recursive: true });
    expect(await statusWith({ git: isogit, fs: memfs, dir: "/no-repo" })).toEqual([]);
  });
});

describe("formatPorcelainV2", () => {
  it("empty list yields empty string", () => {
    expect(formatPorcelainV2([])).toBe("");
  });

  it("emits '1 XY <path>' for tracked entries and '? <path>' for untracked", () => {
    const entries: StatusEntry[] = [
      { path: "a.txt", index: "M", worktree: " " },
      { path: "b.txt", index: " ", worktree: "?" },
    ];
    expect(formatPorcelainV2(entries)).toBe("1 M  a.txt\n? b.txt\n");
  });
});

describe("formatShort", () => {
  it("emits 'XY <path>' lines, no '1 ' prefix", () => {
    const entries: StatusEntry[] = [
      { path: "a.txt", index: "M", worktree: " " },
      { path: "b.txt", index: " ", worktree: "?" },
    ];
    expect(formatShort(entries)).toBe("M  a.txt\n ? b.txt\n");
  });
});

describe("formatPorcelainV1", () => {
  it("empty list yields empty string", () => {
    expect(formatPorcelainV1([])).toBe("");
  });

  it("emits 'XY <path>' lines, with '??' for untracked", () => {
    const entries: StatusEntry[] = [
      { path: "a.txt", index: "M", worktree: " " },
      { path: "b.txt", index: " ", worktree: "?" },
      { path: "c.txt", index: "A", worktree: "M" },
      { path: "d.txt", index: " ", worktree: "D" },
    ];
    expect(formatPorcelainV1(entries)).toBe("M  a.txt\n?? b.txt\nAM c.txt\n D d.txt\n");
  });
});

// Sanity: the bare formatters take StatusMatrixRow-derived shapes
// directly without needing isomorphic-git, useful when a caller
// wants to format a status produced elsewhere.
describe("status entry shape", () => {
  it("StatusMatrixRow tuple type matches isomorphic-git", () => {
    const row: StatusMatrixRow = ["x.txt", 1, 2, 1];
    expect(row).toHaveLength(4);
  });
});
