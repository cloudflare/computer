// Tests for `runGitCli` — the argv-driven dispatcher behind
// `GitClient.cli` and the worker-backend's `git` custom command.
//
// Two layers covered here:
//
//   1. Argv parsing per subcommand. The hand-rolled parser is the
//      bit most likely to drift as new flags land, so every flag
//      mapping for the phase-1 surface has a happy and a sad
//      path. The `GitClient` is faked so the assertions are on
//      which options the dispatcher passes through, not on real
//      git behaviour.
//
//   2. End-to-end `clone` and `diff` against an in-process
//      Workspace + real `isomorphic-git` + the `diff` package, so
//      a future refactor that loses the wiring between `runGitCli`
//      and `GitClient` shows up as a stdout/stderr failure here.
//      The clone phase is faked — same pattern as
//      `clone.test.ts`'s subset-checkout test — because spinning
//      up a real upload-pack server is out of scope.

import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import { Workspace } from "../workspace.js";
import { runGitCli } from "./cli.js";
import type { GitCloneOptions } from "./clone.js";
import type { CommitResult, GitCommitOptions } from "./commit.js";
import type { GitDiffOptions } from "./diff.js";
import {
  AlreadyInitializedError,
  GitError,
  MissingIdentityError,
  NotARepositoryError,
  PathspecNotFoundError,
} from "./errors.js";
import { createGitClient, type GitClient } from "./index.js";
import type { GitInitOptions } from "./init.js";
import type {
  FetchResult,
  GitFetchOptions,
  GitMergeOptions,
  GitPullOptions,
  GitPushOptions,
  GitRemoteAddOptions,
  GitRemoteListOptions,
  GitRemoteRemoveOptions,
  MergeResult,
  PushResult,
  RemoteView,
} from "./network.js";
import type {
  CatFileResult,
  GitCatFileOptions,
  GitConfigGetOptions,
  GitConfigSetOptions,
  GitHashObjectOptions,
  GitUpdateRefOptions,
} from "./plumbing.js";
import type {
  CommitView,
  GitCurrentBranchOptions,
  GitLogOptions,
  GitLsFilesOptions,
  GitLsTreeOptions,
  GitRepoRootOptions,
  GitRevParseOptions,
  GitShowOptions,
  TreeEntryView,
} from "./reads.js";
import type {
  GitBranchDeleteOptions,
  GitBranchListOptions,
  GitBranchOptions,
  GitCheckoutOptions,
  GitTagDeleteOptions,
  GitTagListOptions,
  GitTagOptions,
} from "./refs.js";
import type { GitAddOptions, GitRmOptions } from "./staging.js";
import type { GitStatusOptions, StatusEntry } from "./status.js";

interface FakeCalls {
  clone: GitCloneOptions[];
  diff: GitDiffOptions[];
  diffSummary: GitDiffOptions[];
  init: GitInitOptions[];
  status: GitStatusOptions[];
  add: GitAddOptions[];
  rm: GitRmOptions[];
  commit: GitCommitOptions[];
  log: GitLogOptions[];
  show: GitShowOptions[];
  revParse: GitRevParseOptions[];
  repoRoot: GitRepoRootOptions[];
  currentBranch: GitCurrentBranchOptions[];
  lsFiles: GitLsFilesOptions[];
  lsTree: GitLsTreeOptions[];
  branch: GitBranchOptions[];
  branchDelete: GitBranchDeleteOptions[];
  branchList: GitBranchListOptions[];
  tag: GitTagOptions[];
  tagDelete: GitTagDeleteOptions[];
  tagList: GitTagListOptions[];
  checkout: GitCheckoutOptions[];
  fetch: GitFetchOptions[];
  push: GitPushOptions[];
  pull: GitPullOptions[];
  merge: GitMergeOptions[];
  remoteAdd: GitRemoteAddOptions[];
  remoteRemove: GitRemoteRemoveOptions[];
  remoteList: GitRemoteListOptions[];
  hashObject: GitHashObjectOptions[];
  catFile: GitCatFileOptions[];
  updateRef: GitUpdateRefOptions[];
  configGet: GitConfigGetOptions[];
  configSet: GitConfigSetOptions[];
  stashPush: import("./worktree.js").StashPushOptions[];
  stashList: import("./worktree.js").BaseWorktreeOptions[];
  stashPop: import("./worktree.js").StashPopOptions[];
  reset: import("./worktree.js").ResetOptions[];
  clean: import("./worktree.js").CleanOptions[];
}

function fakeClient(
  overrides: Partial<GitClient> = {},
  fakes: {
    status?: () => StatusEntry[];
    log?: () => CommitView[];
    show?: () => CommitView;
    revParse?: () => string;
    repoRoot?: () => string;
    diffSummary?: () => import("./diff.js").DiffSummaryEntry[];
    currentBranch?: () => string | undefined;
    lsFiles?: () => string[];
    lsTree?: () => TreeEntryView[];
    branchList?: () => string[];
    tagList?: () => string[];
    push?: () => PushResult;
    merge?: () => MergeResult;
    fetch?: () => FetchResult;
    remoteList?: () => RemoteView[];
    hashObject?: () => string;
    catFile?: () => CatFileResult;
    configGet?: () => string | string[] | undefined;
    stashList?: () => string[];
    clean?: () => string[];
  } = {},
): {
  client: GitClient;
  calls: FakeCalls;
} {
  const calls: FakeCalls = {
    clone: [],
    diff: [],
    diffSummary: [],
    init: [],
    status: [],
    add: [],
    rm: [],
    commit: [],
    log: [],
    show: [],
    revParse: [],
    repoRoot: [],
    currentBranch: [],
    lsFiles: [],
    lsTree: [],
    branch: [],
    branchDelete: [],
    branchList: [],
    tag: [],
    tagDelete: [],
    tagList: [],
    checkout: [],
    fetch: [],
    push: [],
    pull: [],
    merge: [],
    remoteAdd: [],
    remoteRemove: [],
    remoteList: [],
    hashObject: [],
    catFile: [],
    updateRef: [],
    configGet: [],
    configSet: [],
    stashPush: [],
    stashList: [],
    stashPop: [],
    reset: [],
    clean: [],
  };
  const client: GitClient = {
    async clone(options) {
      calls.clone.push(options);
    },
    async diff(options = {}) {
      calls.diff.push(options);
      return "";
    },
    async diffSummary(options = {}) {
      calls.diffSummary.push(options);
      return fakes.diffSummary?.() ?? [];
    },
    async init(options = {}) {
      calls.init.push(options);
    },
    async status(options = {}) {
      calls.status.push(options);
      return fakes.status?.() ?? [];
    },
    async add(options) {
      calls.add.push(options);
    },
    async rm(options) {
      calls.rm.push(options);
    },
    async commit(options): Promise<CommitResult> {
      calls.commit.push(options);
      return { oid: "a".repeat(40) };
    },
    async log(options = {}) {
      calls.log.push(options);
      return fakes.log?.() ?? [];
    },
    async show(options) {
      calls.show.push(options);
      return (
        fakes.show?.() ?? {
          oid: "a".repeat(40),
          message: "",
          tree: "",
          parent: [],
          author: { name: "", email: "", timestamp: 0, timezoneOffset: 0 },
          committer: { name: "", email: "", timestamp: 0, timezoneOffset: 0 },
        }
      );
    },
    async revParse(options) {
      calls.revParse.push(options);
      return fakes.revParse?.() ?? "a".repeat(40);
    },
    async repoRoot(options = {}) {
      calls.repoRoot.push(options);
      return fakes.repoRoot?.() ?? "/";
    },
    async currentBranch(options = {}) {
      calls.currentBranch.push(options);
      return fakes.currentBranch?.();
    },
    async lsFiles(options = {}) {
      calls.lsFiles.push(options);
      return fakes.lsFiles?.() ?? [];
    },
    async lsTree(options) {
      calls.lsTree.push(options);
      return fakes.lsTree?.() ?? [];
    },
    async branch(options) {
      calls.branch.push(options);
    },
    async branchDelete(options) {
      calls.branchDelete.push(options);
    },
    async branchList(options = {}) {
      calls.branchList.push(options);
      return fakes.branchList?.() ?? [];
    },
    async tag(options) {
      calls.tag.push(options);
    },
    async tagDelete(options) {
      calls.tagDelete.push(options);
    },
    async tagList(options = {}) {
      calls.tagList.push(options);
      return fakes.tagList?.() ?? [];
    },
    async checkout(options) {
      calls.checkout.push(options);
    },
    async fetch(options = {}) {
      calls.fetch.push(options);
      return fakes.fetch?.() ?? { defaultBranch: "main", fetchHead: null };
    },
    async push(options = {}) {
      calls.push.push(options);
      return fakes.push?.() ?? { ok: true, error: null, refs: {} };
    },
    async pull(options = {}) {
      calls.pull.push(options);
    },
    async merge(options) {
      calls.merge.push(options);
      return fakes.merge?.() ?? { fastForward: true, oid: "f".repeat(40) };
    },
    async remoteAdd(options) {
      calls.remoteAdd.push(options);
    },
    async remoteRemove(options) {
      calls.remoteRemove.push(options);
    },
    async remoteList(options = {}) {
      calls.remoteList.push(options);
      return fakes.remoteList?.() ?? [];
    },
    async hashObject(options) {
      calls.hashObject.push(options);
      return fakes.hashObject?.() ?? "a".repeat(40);
    },
    async catFile(options) {
      calls.catFile.push(options);
      return (
        fakes.catFile?.() ?? {
          oid: "a".repeat(40),
          bytes: new TextEncoder().encode(""),
        }
      );
    },
    async updateRef(options) {
      calls.updateRef.push(options);
    },
    async configGet(options) {
      calls.configGet.push(options);
      return fakes.configGet?.();
    },
    async configSet(options) {
      calls.configSet.push(options);
    },
    async stashPush(options = {}) {
      calls.stashPush.push(options);
    },
    async stashList(options = {}) {
      calls.stashList.push(options);
      return fakes.stashList?.() ?? [];
    },
    async stashPop(options = {}) {
      calls.stashPop.push(options);
    },
    async reset(options = {}) {
      calls.reset.push(options);
    },
    async clean(options = {}) {
      calls.clean.push(options);
      return fakes.clean?.() ?? [];
    },
    async cli() {
      throw new Error("not reached in these tests");
    },
    ...overrides,
  };
  return { client, calls };
}

describe("runGitCli — dispatch", () => {
  it("prints help when argv is empty", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: [] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("usage: git <command>");
    expect(res.stderr).toBe("");
  });

  it("`help`, `--help`, and `-h` all print help", async () => {
    const { client } = fakeClient();
    for (const argv of [["help"], ["--help"], ["-h"]]) {
      const res = await runGitCli(client, { argv });
      expect(res.exitCode, JSON.stringify(argv)).toBe(0);
      expect(res.stdout).toContain("usage: git <command>");
    }
  });

  it("`version` prints a self-identifying version string", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["version"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("@cloudflare/computer");
  });

  it("unknown subcommands exit 1 with a git-shaped stderr line", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["nope"] });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("'nope' is not a supported workspace git command");
  });
});

describe("runGitCli — global -C <path>", () => {
  it("runs the subcommand with cwd set to an absolute -C path", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["-C", "/repo", "status", "--short"],
      cwd: "/elsewhere",
    });
    expect(res.exitCode).toBe(0);
    expect(calls.status[0].dir).toBe("/repo");
  });

  it("resolves a relative -C path against cwd", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["-C", "sub", "status"],
      cwd: "/work",
    });
    expect(calls.status[0].dir).toBe("/work/sub");
  });

  it("applies -C before a subcommand that takes its own dir default", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["-C", "/repo", "log", "-n", "1", "--oneline"],
      cwd: "/elsewhere",
    });
    expect(calls.log[0].dir).toBe("/repo");
  });

  it("exits 129 when -C is missing its value", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["-C"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("-C");
  });

  it("rejects a second -C as unsupported", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["-C", "/a", "-C", "/b", "status"],
    });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("-C");
  });
});

describe("runGitCli — clone argv parsing", () => {
  it("forwards a bare URL, deriving the dir from the URL basename", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["clone", "https://example.test/r.git"],
      cwd: "/work",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Cloning into '/work/r'");
    expect(calls.clone).toEqual([
      {
        url: "https://example.test/r.git",
        dir: "/work/r",
        ref: undefined,
        depth: undefined,
        singleBranch: undefined,
        noTags: undefined,
      },
    ]);
  });

  it("derives the dir from the URL basename, stripping a .git suffix", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["clone", "https://github.com/cloudflare/computer"],
      cwd: "/workspace",
    });
    expect(calls.clone[0].dir).toBe("/workspace/computer");
  });

  it("derives the dir from a URL with a trailing slash", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["clone", "https://github.com/cloudflare/computer/"],
      cwd: "/workspace",
    });
    expect(calls.clone[0].dir).toBe("/workspace/computer");
  });

  it("prefers an explicit destination over the derived basename", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["clone", "https://github.com/cloudflare/computer", "/dst/cf-workspace"],
      cwd: "/work",
    });
    expect(calls.clone[0].dir).toBe("/dst/cf-workspace");
  });

  it("rejects a URL whose basename cannot produce a safe dir", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["clone", "https://example.test/"],
      cwd: "/work",
    });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("could not derive");
  });

  it("forwards --depth, --branch (-b), --single-branch, --no-tags", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, {
      argv: [
        "clone",
        "--depth",
        "5",
        "-b",
        "develop",
        "--single-branch",
        "--no-tags",
        "https://example.test/r.git",
        "/dst",
      ],
    });
    expect(res.exitCode).toBe(0);
    expect(calls.clone[0]).toMatchObject({
      url: "https://example.test/r.git",
      dir: "/dst",
      ref: "develop",
      depth: 5,
      singleBranch: true,
      noTags: true,
    });
  });

  it("supports --no-single-branch and --tags (the negated forms)", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["clone", "--no-single-branch", "--tags", "https://example.test/r.git"],
    });
    expect(calls.clone[0]).toMatchObject({
      singleBranch: false,
      noTags: false,
    });
  });

  it("supports --flag=value form", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["clone", "--depth=2", "--branch=main", "https://example.test/r.git"],
    });
    expect(calls.clone[0]).toMatchObject({ depth: 2, ref: "main" });
  });

  it("resolves a relative target dir against cwd", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["clone", "https://example.test/r.git", "sub"],
      cwd: "/work",
    });
    expect(calls.clone[0].dir).toBe("/work/sub");
  });

  it("rejects unknown options with exit 129 and a clear stderr", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["clone", "--bogus", "https://example.test/r.git"],
    });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("unknown option '--bogus'");
  });

  it("rejects --depth with a non-numeric value", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["clone", "--depth", "abc", "https://example.test/r.git"],
    });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("--depth");
  });

  it("rejects clone with no URL", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["clone"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("missing <repository>");
  });

  it("rejects unsupported transports (ssh, git://)", async () => {
    const { client } = fakeClient();
    for (const url of [
      "ssh://git@example.test/r.git",
      "git@example.test:r.git",
      "git://example.test/r.git",
    ]) {
      const res = await runGitCli(client, { argv: ["clone", url] });
      expect(res.exitCode, url).toBe(1);
      expect(res.stderr).toContain("unsupported transport");
    }
  });

  it("surfaces a GitClient.clone rejection as exit 1 with the error on stderr", async () => {
    const { client } = fakeClient({
      async clone() {
        throw new Error("upload-pack 502");
      },
    });
    const res = await runGitCli(client, {
      argv: ["clone", "https://example.test/r.git"],
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("upload-pack 502");
  });
});

describe("runGitCli — diff argv parsing", () => {
  it("calls diff() with no ref by default", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["diff"], cwd: "/repo" });
    expect(calls.diff).toEqual([{ dir: "/repo", ref: undefined }]);
  });

  it("passes a positional ref through", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["diff", "v1.0"], cwd: "/repo" });
    expect(calls.diff).toEqual([{ dir: "/repo", ref: "v1.0" }]);
  });

  it("passes two positional refs as from/to", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["diff", "v1", "v2"], cwd: "/r" });
    expect(calls.diff).toEqual([{ dir: "/r", ref: "v1", to: "v2", paths: undefined }]);
  });

  it("pre-resolves revision suffixes in from/to refs", async () => {
    let n = 0;
    const oids = ["a".repeat(40), "b".repeat(40)];
    const { client, calls } = fakeClient({}, { revParse: () => oids[n++] });
    await runGitCli(client, { argv: ["diff", "HEAD~2", "HEAD~1"], cwd: "/r" });
    expect(calls.diff[0]).toMatchObject({ ref: "a".repeat(40), to: "b".repeat(40) });
  });

  it("rejects three or more refs before '--'", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["diff", "a", "b", "c"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("too many refs");
  });

  it("paths after '--' become the paths filter", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["diff", "v1", "v2", "--", "src/", "README.md"],
      cwd: "/r",
    });
    expect(calls.diff).toEqual([{ dir: "/r", ref: "v1", to: "v2", paths: ["src/", "README.md"] }]);
  });

  it("returns the diff text on stdout", async () => {
    const { client } = fakeClient({
      async diff() {
        return "--- a.txt\n+++ a.txt\n@@\n-x\n+y\n";
      },
    });
    const res = await runGitCli(client, { argv: ["diff"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--- a.txt");
  });

  it("--name-only lists changed paths, one per line", async () => {
    const { client, calls } = fakeClient(
      {},
      {
        diffSummary: () => [
          { path: "a.txt", status: "M", insertions: 1, deletions: 1 },
          { path: "b.txt", status: "A", insertions: 2, deletions: 0 },
        ],
      },
    );
    const res = await runGitCli(client, { argv: ["diff", "--name-only"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("a.txt\nb.txt\n");
    expect(calls.diffSummary[0]).toMatchObject({ dir: "/r" });
    expect(calls.diff).toEqual([]);
  });

  it("--name-status prefixes each path with its status", async () => {
    const { client } = fakeClient(
      {},
      {
        diffSummary: () => [
          { path: "a.txt", status: "M", insertions: 1, deletions: 1 },
          { path: "gone.txt", status: "D", insertions: 0, deletions: 3 },
        ],
      },
    );
    const res = await runGitCli(client, { argv: ["diff", "--name-status"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("M\ta.txt\nD\tgone.txt\n");
  });

  it("--stat summarizes files with insertion/deletion counts", async () => {
    const { client } = fakeClient(
      {},
      {
        diffSummary: () => [
          { path: "a.txt", status: "M", insertions: 3, deletions: 1 },
          { path: "b.txt", status: "A", insertions: 2, deletions: 0 },
        ],
      },
    );
    const res = await runGitCli(client, { argv: ["diff", "--stat"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(
      " a.txt |    4 +++-\n b.txt |    2 ++\n 2 files changed, 5 insertions(+), 1 deletion(-)\n",
    );
  });

  it("--stat emits nothing for an empty change set", async () => {
    const { client } = fakeClient({}, { diffSummary: () => [] });
    const res = await runGitCli(client, { argv: ["diff", "--stat"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("--name-only works with ref-to-ref and revision suffixes", async () => {
    let n = 0;
    const oids = ["a".repeat(40), "b".repeat(40)];
    const { client, calls } = fakeClient(
      {},
      {
        revParse: () => oids[n++],
        diffSummary: () => [{ path: "x", status: "M", insertions: 1, deletions: 0 }],
      },
    );
    await runGitCli(client, { argv: ["diff", "--name-only", "HEAD~2", "HEAD~1"], cwd: "/r" });
    expect(calls.diffSummary[0]).toMatchObject({ ref: "a".repeat(40), to: "b".repeat(40) });
  });
});

describe("runGitCli — init argv parsing", () => {
  it("calls init() with cwd as the default dir", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["init"], cwd: "/work" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Initialized empty Git repository in /work/.git/");
    expect(calls.init).toEqual([{ dir: "/work", defaultBranch: undefined, bare: false }]);
  });

  it("passes --initial-branch / -b through", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["init", "--initial-branch", "trunk"],
      cwd: "/work",
    });
    expect(calls.init[0].defaultBranch).toBe("trunk");
  });

  it("--bare flips the option", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["init", "--bare", "/bare"] });
    expect(calls.init[0]).toMatchObject({ dir: "/bare", bare: true });
  });

  it("AlreadyInitializedError maps to exit 128 with a stderr line", async () => {
    const { client } = fakeClient({
      async init() {
        throw new AlreadyInitializedError("/work");
      },
    });
    const res = await runGitCli(client, { argv: ["init"], cwd: "/work" });
    expect(res.exitCode).toBe(128);
    expect(res.stderr).toContain("already exists");
  });
});

describe("runGitCli — status argv parsing", () => {
  it("calls status() with cwd as dir and emits porcelain v2 by default", async () => {
    const { client, calls } = fakeClient(
      {},
      {
        status: () => [
          { path: "a.txt", index: "M", worktree: " " },
          { path: "b.txt", index: " ", worktree: "?" },
        ],
      },
    );
    const res = await runGitCli(client, { argv: ["status"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.status).toEqual([{ dir: "/r" }]);
    expect(res.stdout).toBe("1 M  a.txt\n? b.txt\n");
  });

  it("--short flips to the short format", async () => {
    const { client } = fakeClient(
      {},
      {
        status: () => [{ path: "a.txt", index: "M", worktree: " " }],
      },
    );
    const res = await runGitCli(client, { argv: ["status", "--short"] });
    expect(res.stdout).toBe("M  a.txt\n");
  });

  it("-s is an alias for --short", async () => {
    const { client } = fakeClient(
      {},
      {
        status: () => [{ path: "a.txt", index: "M", worktree: " " }],
      },
    );
    const res = await runGitCli(client, { argv: ["status", "-s"] });
    expect(res.stdout).toBe("M  a.txt\n");
  });

  it("--porcelain=v2 explicitly selects v2", async () => {
    const { client } = fakeClient(
      {},
      {
        status: () => [{ path: "a.txt", index: "M", worktree: " " }],
      },
    );
    const res = await runGitCli(client, { argv: ["status", "--porcelain=v2"] });
    expect(res.stdout).toBe("1 M  a.txt\n");
  });

  it("--porcelain=v1 selects the v1 (XY path) format", async () => {
    const { client } = fakeClient(
      {},
      {
        status: () => [
          { path: "a.txt", index: "M", worktree: " " },
          { path: "b.txt", index: " ", worktree: "?" },
        ],
      },
    );
    const res = await runGitCli(client, { argv: ["status", "--porcelain=v1"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("M  a.txt\n?? b.txt\n");
  });

  it("--porcelain=v1 emits nothing for a clean tree", async () => {
    const { client } = fakeClient({}, { status: () => [] });
    const res = await runGitCli(client, { argv: ["status", "--porcelain=v1"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("--porcelain with an unknown value is an error", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["status", "--porcelain=v3"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("unsupported --porcelain value");
  });

  it("NotARepositoryError maps to exit 128", async () => {
    const { client } = fakeClient({
      async status() {
        throw new NotARepositoryError("/no");
      },
    });
    const res = await runGitCli(client, { argv: ["status"], cwd: "/no" });
    expect(res.exitCode).toBe(128);
    expect(res.stderr).toContain("not a git repository");
  });

  it("empty status produces empty stdout", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["status"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
  });
});

describe("runGitCli — add argv parsing", () => {
  it("passes positional pathspecs through", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["add", "a.txt", "b.txt"], cwd: "/r" });
    expect(calls.add).toEqual([{ dir: "/r", paths: ["a.txt", "b.txt"], all: false, force: false }]);
  });

  it("--force / -f flips the option", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["add", "-f", "a.txt"] });
    expect(calls.add[0].force).toBe(true);
  });

  it("empty argv is an error (matching real git)", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["add"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("nothing specified");
  });

  it("PathspecNotFoundError maps to exit 128", async () => {
    const { client } = fakeClient({
      async add() {
        throw new PathspecNotFoundError("missing.txt");
      },
    });
    const res = await runGitCli(client, { argv: ["add", "missing.txt"] });
    expect(res.exitCode).toBe(128);
    expect(res.stderr).toContain("pathspec 'missing.txt'");
  });
});

describe("runGitCli — rm argv parsing", () => {
  it("passes positional pathspecs through", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["rm", "a.txt"], cwd: "/r" });
    expect(calls.rm).toEqual([{ dir: "/r", paths: ["a.txt"] }]);
  });

  it("empty argv is an error", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["rm"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("no pathspec");
  });
});

describe("runGitCli — commit argv parsing", () => {
  it("requires -m <message>", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["commit"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("-m <message> is required");
  });

  it("calls commit() with the resolved message and forwards env", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["commit", "-m", "first"],
      cwd: "/r",
      env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@x" },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("[aaaaaaa] first");
    expect(calls.commit[0]).toMatchObject({
      dir: "/r",
      message: "first",
      env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@x" },
    });
  });

  it("--author='Name <email>' parses into author", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["commit", "-m", "x", "--author", "Alice <a@x>"],
    });
    expect(calls.commit[0].author).toEqual({ name: "Alice", email: "a@x" });
  });

  it("malformed --author is rejected with exit 129", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["commit", "-m", "x", "--author", "no-email-here"],
    });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("malformed --author");
  });

  it("--amend flips the option", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["commit", "-m", "x", "--amend"] });
    expect(calls.commit[0].amend).toBe(true);
  });

  it("-a stages tracked changes before committing", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["commit", "-a", "-m", "x"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.add).toEqual([{ dir: "/r", paths: [], all: true, trackedOnly: true }]);
    expect(calls.commit).toHaveLength(1);
  });

  it("-am combines -a and -m", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["commit", "-am", "msg"] });
    expect(res.exitCode).toBe(0);
    expect(calls.add[0]).toMatchObject({ all: true, trackedOnly: true });
    expect(calls.commit[0]).toMatchObject({ message: "msg" });
  });

  it("commit without -a does not stage", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["commit", "-m", "x"] });
    expect(calls.add).toEqual([]);
  });

  it("-a propagates a staging failure and does not commit", async () => {
    const { client, calls } = fakeClient({
      async add() {
        throw new NotARepositoryError("/r");
      },
    });
    const res = await runGitCli(client, { argv: ["commit", "-a", "-m", "x"] });
    expect(res.exitCode).toBe(128);
    expect(calls.commit).toEqual([]);
  });

  it("MissingIdentityError maps to exit 128", async () => {
    const { client } = fakeClient({
      async commit() {
        throw new MissingIdentityError();
      },
    });
    const res = await runGitCli(client, { argv: ["commit", "-m", "x"] });
    expect(res.exitCode).toBe(128);
    expect(res.stderr).toContain("author identity unknown");
  });
});

describe("runGitCli — log argv parsing", () => {
  const sample = (oid: string, msg: string, timezoneOffset = 0): CommitView => ({
    oid,
    message: msg,
    tree: "",
    parent: [],
    author: {
      name: "A",
      email: "a@x",
      timestamp: 1_700_000_000,
      timezoneOffset,
    },
    committer: {
      name: "A",
      email: "a@x",
      timestamp: 1_700_000_000,
      timezoneOffset,
    },
  });

  it("--oneline emits one line per commit", async () => {
    const { client } = fakeClient(
      {},
      {
        log: () => [sample("a".repeat(40), "second"), sample("b".repeat(40), "first")],
      },
    );
    const res = await runGitCli(client, { argv: ["log", "--oneline"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("aaaaaaa second\nbbbbbbb first\n");
  });

  it("full form emits commit / Author / Date / message blocks", async () => {
    const { client } = fakeClient(
      {},
      {
        log: () => [sample("a".repeat(40), "hello\nworld")],
      },
    );
    const res = await runGitCli(client, { argv: ["log"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`commit ${"a".repeat(40)}`);
    expect(res.stdout).toContain("Author: A <a@x>");
    expect(res.stdout).toContain("Date:   2023-11-14 22:13:20 +0000");
    expect(res.stdout).toContain("    hello");
    expect(res.stdout).toContain("    world");
  });

  it("shifts full-form Date into the author's timezone", async () => {
    const { client } = fakeClient(
      {},
      {
        log: () => [sample("a".repeat(40), "hello", -330)],
      },
    );
    const res = await runGitCli(client, { argv: ["log"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Date:   2023-11-15 03:43:20 +0530");
  });

  it("-n forwards as depth", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["log", "-n", "3"] });
    expect(calls.log[0].depth).toBe(3);
  });

  it("-n with a non-numeric value is an error", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["log", "-n", "abc"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("-n");
  });

  it("pre-resolves a revision suffix in the positional ref", async () => {
    const { client, calls } = fakeClient({}, { revParse: () => "e".repeat(40) });
    await runGitCli(client, { argv: ["log", "HEAD~2"], cwd: "/r" });
    expect(calls.revParse[0]).toMatchObject({ ref: "HEAD~2" });
    expect(calls.log[0].ref).toBe("e".repeat(40));
  });

  it("-1 is shorthand for -n 1", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["log", "-1", "--oneline"] });
    expect(res.exitCode).toBe(0);
    expect(calls.log[0].depth).toBe(1);
  });

  it("-5 is shorthand for -n 5", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["log", "-5"] });
    expect(calls.log[0].depth).toBe(5);
  });

  it("-0 is rejected", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["log", "-0"] });
    expect(res.exitCode).toBe(129);
  });
});

describe("runGitCli — show / rev-parse / symbolic-ref", () => {
  it("show <ref> calls show() with the resolved ref", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["show", "v1.0"], cwd: "/r" });
    expect(calls.show).toEqual([{ dir: "/r", ref: "v1.0" }]);
  });

  it("show with no positional defaults to HEAD", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["show"] });
    expect(calls.show[0].ref).toBe("HEAD");
  });

  it("show pre-resolves a revision suffix to an oid", async () => {
    const { client, calls } = fakeClient({}, { revParse: () => "d".repeat(40) });
    await runGitCli(client, { argv: ["show", "HEAD~1"], cwd: "/r" });
    expect(calls.revParse[0]).toMatchObject({ dir: "/r", ref: "HEAD~1" });
    expect(calls.show[0].ref).toBe("d".repeat(40));
  });

  it("rev-parse prints the resolved oid", async () => {
    const { client } = fakeClient({}, { revParse: () => "deadbeef".repeat(5) });
    const res = await runGitCli(client, { argv: ["rev-parse", "HEAD"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(`${"deadbeef".repeat(5)}\n`);
  });

  it("rev-parse without a ref is an error", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["rev-parse"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("missing <ref>");
  });

  it("rev-parse --abbrev-ref HEAD prints the current branch", async () => {
    const { client, calls } = fakeClient({}, { currentBranch: () => "main" });
    const res = await runGitCli(client, {
      argv: ["rev-parse", "--abbrev-ref", "HEAD"],
      cwd: "/r",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("main\n");
    expect(calls.currentBranch[0]).toMatchObject({ dir: "/r" });
    expect(calls.revParse).toEqual([]);
  });

  it("rev-parse --abbrev-ref on detached HEAD falls back to the oid", async () => {
    const { client } = fakeClient(
      {},
      { currentBranch: () => undefined, revParse: () => "c".repeat(40) },
    );
    const res = await runGitCli(client, { argv: ["rev-parse", "--abbrev-ref", "HEAD"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(`${"c".repeat(40)}\n`);
  });

  it("rev-parse --show-toplevel prints the repo root", async () => {
    const { client, calls } = fakeClient({}, { repoRoot: () => "/work/repo" });
    const res = await runGitCli(client, {
      argv: ["rev-parse", "--show-toplevel"],
      cwd: "/work/repo/sub",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("/work/repo\n");
    expect(calls.repoRoot[0]).toMatchObject({ dir: "/work/repo/sub" });
  });

  it("rev-parse --show-toplevel maps NotARepositoryError to exit 128", async () => {
    const { client } = fakeClient({
      async repoRoot() {
        throw new NotARepositoryError("/loose");
      },
    });
    const res = await runGitCli(client, { argv: ["rev-parse", "--show-toplevel"] });
    expect(res.exitCode).toBe(128);
    expect(res.stderr).toContain("not a git repository");
  });

  it("symbolic-ref HEAD prints the full ref by default", async () => {
    const { client, calls } = fakeClient({}, { currentBranch: () => "refs/heads/main" });
    const res = await runGitCli(client, { argv: ["symbolic-ref", "HEAD"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("refs/heads/main\n");
    expect(calls.currentBranch[0].fullname).toBe(true);
  });

  it("symbolic-ref --short asks for the short name", async () => {
    const { client, calls } = fakeClient({}, { currentBranch: () => "main" });
    const res = await runGitCli(client, { argv: ["symbolic-ref", "--short", "HEAD"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("main\n");
    expect(calls.currentBranch[0].fullname).toBe(false);
  });

  it("symbolic-ref on detached HEAD exits 1", async () => {
    const { client } = fakeClient({}, { currentBranch: () => undefined });
    const res = await runGitCli(client, { argv: ["symbolic-ref", "HEAD"] });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a symbolic ref");
  });

  it("symbolic-ref rejects refs other than HEAD", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["symbolic-ref", "refs/heads/foo"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("only HEAD is supported");
  });
});

describe("runGitCli — ls-files / ls-tree", () => {
  it("ls-files prints one filename per line", async () => {
    const { client } = fakeClient({}, { lsFiles: () => ["a.txt", "b.txt"] });
    const res = await runGitCli(client, { argv: ["ls-files"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("a.txt\nb.txt\n");
  });

  it("ls-files --ref forwards as the ref option", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["ls-files", "--ref", "v1"] });
    expect(calls.lsFiles[0].ref).toBe("v1");
  });

  it("ls-files on empty list emits empty stdout (no trailing newline)", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["ls-files"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("ls-tree prints '<mode> <type> <oid>\\t<path>' lines", async () => {
    const { client } = fakeClient(
      {},
      {
        lsTree: () => [
          { mode: "100644", path: "a.txt", oid: "a".repeat(40), type: "blob" },
          { mode: "040000", path: "sub", oid: "b".repeat(40), type: "tree" },
        ],
      },
    );
    const res = await runGitCli(client, { argv: ["ls-tree", "HEAD"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(
      `100644 blob ${"a".repeat(40)}\ta.txt\n040000 tree ${"b".repeat(40)}\tsub\n`,
    );
  });

  it("ls-tree requires a tree-ish", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["ls-tree"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("missing <tree-ish>");
  });

  it("ls-tree forwards a sub-path positional", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["ls-tree", "HEAD", "sub"] });
    expect(calls.lsTree[0]).toMatchObject({ ref: "HEAD", path: "sub" });
  });
});

describe("runGitCli — branch argv parsing", () => {
  it("bare `branch` lists branches with a leading '* ' on current", async () => {
    const { client } = fakeClient(
      {},
      {
        branchList: () => ["feature", "main"],
        currentBranch: () => "main",
      },
    );
    const res = await runGitCli(client, { argv: ["branch"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("  feature\n* main\n");
  });

  it("branch <name> creates a branch at HEAD", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["branch", "feature"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.branch).toEqual([
      { dir: "/r", name: "feature", startPoint: undefined, force: false },
    ]);
  });

  it("branch <name> <start> passes the start point through", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["branch", "feature", "v1"] });
    expect(calls.branch[0]).toMatchObject({ name: "feature", startPoint: "v1" });
  });

  it("branch -d <name> deletes a branch", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["branch", "-d", "feature"] });
    expect(res.exitCode).toBe(0);
    expect(calls.branchDelete).toEqual([{ dir: "/", name: "feature" }]);
    expect(calls.branch).toEqual([]);
  });

  it("branch -d with no name is an error", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["branch", "-d"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("-d requires a branch name");
  });

  it("branch --force flips the option", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["branch", "--force", "feature", "v1"] });
    expect(calls.branch[0].force).toBe(true);
  });

  it("branch --show-current prints the current branch", async () => {
    const { client, calls } = fakeClient({}, { currentBranch: () => "main" });
    const res = await runGitCli(client, { argv: ["branch", "--show-current"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("main\n");
    expect(calls.currentBranch[0]).toMatchObject({ dir: "/r" });
    expect(calls.branchList).toEqual([]);
  });

  it("branch --show-current prints nothing on detached HEAD", async () => {
    const { client } = fakeClient({}, { currentBranch: () => undefined });
    const res = await runGitCli(client, { argv: ["branch", "--show-current"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
  });
});

describe("runGitCli — tag argv parsing", () => {
  it("bare `tag` lists tags lexicographically", async () => {
    const { client } = fakeClient({}, { tagList: () => ["v2", "v1"] });
    const res = await runGitCli(client, { argv: ["tag"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("v1\nv2\n");
  });

  it("tag <name> creates a tag at HEAD", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["tag", "v1.0"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.tag).toEqual([{ dir: "/r", name: "v1.0", object: undefined, force: false }]);
  });

  it("tag <name> <object> tags a specific commit", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["tag", "v1.0", "deadbee"] });
    expect(calls.tag[0]).toMatchObject({ name: "v1.0", object: "deadbee" });
  });

  it("tag -d <name> deletes a tag", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["tag", "-d", "v1.0"] });
    expect(res.exitCode).toBe(0);
    expect(calls.tagDelete).toEqual([{ dir: "/", name: "v1.0" }]);
  });
});

describe("runGitCli — checkout argv parsing", () => {
  it("checkout <ref> moves HEAD", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["checkout", "feature"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.checkout).toEqual([{ dir: "/r", ref: "feature", paths: undefined, force: false }]);
  });

  it("paths after '--' switch to path-scoped checkout", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["checkout", "v1", "--", "a.txt", "b.txt"] });
    expect(calls.checkout[0]).toMatchObject({
      ref: "v1",
      paths: ["a.txt", "b.txt"],
    });
  });

  it("--force flips the option", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["checkout", "--force", "v1"] });
    expect(calls.checkout[0].force).toBe(true);
  });

  it("checkout with no ref is an error", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["checkout"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("missing <ref>");
  });

  it("checkout -b creates a branch and switches to it", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["checkout", "-b", "feature"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.branch).toEqual([
      { dir: "/r", name: "feature", startPoint: undefined, force: false },
    ]);
    expect(calls.checkout).toEqual([{ dir: "/r", ref: "feature" }]);
  });

  it("checkout -b <name> <start> creates the branch at the start point", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["checkout", "-b", "feature", "v1"] });
    expect(calls.branch[0]).toMatchObject({ name: "feature", startPoint: "v1" });
    expect(calls.checkout[0]).toMatchObject({ ref: "feature" });
  });

  it("checkout -b requires a branch name", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["checkout", "-b"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("requires a branch name");
  });

  it("checkout -b does not switch if branch creation fails", async () => {
    const { client, calls } = fakeClient({
      async branch() {
        throw new GitError("EBRANCHFAIL", "branch 'feature' already exists");
      },
    });
    const res = await runGitCli(client, { argv: ["checkout", "-b", "feature"] });
    expect(res.exitCode).toBe(1);
    expect(calls.checkout).toEqual([]);
  });
});

describe("runGitCli — switch argv parsing", () => {
  it("switch <branch> moves HEAD", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["switch", "feature"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.checkout).toEqual([{ dir: "/r", ref: "feature" }]);
  });

  it("switch -c creates a branch and switches to it", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["switch", "-c", "feature"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.branch[0]).toMatchObject({ name: "feature" });
    expect(calls.checkout[0]).toMatchObject({ ref: "feature" });
  });

  it("switch -c <name> <start> honors the start point", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["switch", "-c", "feature", "main"] });
    expect(calls.branch[0]).toMatchObject({ name: "feature", startPoint: "main" });
  });

  it("switch with no branch is an error", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["switch"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("missing <branch>");
  });
});

describe("runGitCli — fetch argv parsing", () => {
  it("bare `fetch` calls with no remote / ref", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["fetch"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.fetch).toEqual([
      {
        dir: "/r",
        url: undefined,
        remote: undefined,
        ref: undefined,
        depth: undefined,
        singleBranch: undefined,
        tags: undefined,
        prune: false,
      },
    ]);
  });

  it("forwards a remote name positional", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["fetch", "origin", "main"] });
    expect(calls.fetch[0]).toMatchObject({ remote: "origin", ref: "main" });
  });

  it("forwards a URL positional as `url`", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["fetch", "https://example.test/r.git"] });
    expect(calls.fetch[0]).toMatchObject({
      url: "https://example.test/r.git",
      remote: undefined,
    });
  });

  it("rejects ssh:// URLs", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["fetch", "ssh://git@example.test/r.git"] });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("unsupported transport");
  });

  it("--depth and --prune are forwarded", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["fetch", "--depth", "3", "--prune", "origin"] });
    expect(calls.fetch[0]).toMatchObject({ depth: 3, prune: true });
  });
});

describe("runGitCli — push argv parsing", () => {
  it("forwards remote / ref positionals and --force / --delete", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["push", "--force", "origin", "main"], cwd: "/r" });
    expect(calls.push).toEqual([
      {
        dir: "/r",
        url: undefined,
        remote: "origin",
        ref: "main",
        force: true,
        delete: false,
      },
    ]);
  });

  it("splits a single-colon refspec for URL pushes", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["push", "--force", "https://example.test/r.git", "HEAD:main"],
      cwd: "/r",
    });
    expect(calls.push).toEqual([
      {
        dir: "/r",
        url: "https://example.test/r.git",
        remote: undefined,
        ref: "HEAD",
        remoteRef: "main",
        force: true,
        delete: false,
      },
    ]);
  });

  it("surfaces a non-ok PushResult as exit 1 on stderr", async () => {
    const { client } = fakeClient(
      {},
      {
        push: () => ({
          ok: false,
          error: "non-fast-forward",
          refs: {},
        }),
      },
    );
    const res = await runGitCli(client, { argv: ["push"] });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("non-fast-forward");
  });
});

describe("runGitCli — pull argv parsing", () => {
  it("forwards remote / ref and --ff-only", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["pull", "--ff-only", "origin", "main"],
      cwd: "/r",
      env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@x" },
    });
    expect(calls.pull[0]).toMatchObject({
      dir: "/r",
      remote: "origin",
      ref: "main",
      fastForwardOnly: true,
      env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@x" },
    });
  });

  it("--no-ff turns fast-forward off", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["pull", "--no-ff"] });
    expect(calls.pull[0].fastForward).toBe(false);
  });
});

describe("runGitCli — merge argv parsing", () => {
  it("forwards theirs and --ff-only / -m", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["merge", "--ff-only", "-m", "merge feature", "feature"],
      cwd: "/r",
    });
    expect(calls.merge[0]).toMatchObject({
      dir: "/r",
      theirs: "feature",
      fastForwardOnly: true,
      message: "merge feature",
    });
  });

  it("prints the appropriate summary line for a fast-forward", async () => {
    const { client } = fakeClient(
      {},
      {
        merge: () => ({ fastForward: true, oid: "a".repeat(40) }),
      },
    );
    const res = await runGitCli(client, { argv: ["merge", "feature"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Fast-forward to aaaaaaa");
  });

  it("prints 'Already up to date.' on a no-op merge", async () => {
    const { client } = fakeClient({}, { merge: () => ({ alreadyMerged: true }) });
    const res = await runGitCli(client, { argv: ["merge", "feature"] });
    expect(res.stdout).toBe("Already up to date.\n");
  });

  it("merge with no ref is an error", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["merge"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("missing <ref>");
  });
});

describe("runGitCli — remote argv parsing", () => {
  it("bare `remote` lists names lexicographically", async () => {
    const { client } = fakeClient(
      {},
      {
        remoteList: () => [
          { name: "origin", url: "https://example.test/r.git" },
          { name: "fork", url: "https://fork.example.test/r.git" },
        ],
      },
    );
    const res = await runGitCli(client, { argv: ["remote"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("fork\norigin\n");
  });

  it("`remote -v` prints fetch and push lines per remote", async () => {
    const { client } = fakeClient(
      {},
      {
        remoteList: () => [{ name: "origin", url: "https://example.test/r.git" }],
      },
    );
    const res = await runGitCli(client, { argv: ["remote", "-v"] });
    expect(res.stdout).toBe(
      "origin\thttps://example.test/r.git (fetch)\norigin\thttps://example.test/r.git (push)\n",
    );
  });

  it("`remote add` accepts a name and URL", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["remote", "add", "origin", "https://example.test/r.git"],
    });
    expect(res.exitCode).toBe(0);
    expect(calls.remoteAdd).toEqual([
      {
        dir: "/",
        name: "origin",
        url: "https://example.test/r.git",
        force: false,
      },
    ]);
  });

  it("`remote add` rejects ssh URLs", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["remote", "add", "origin", "ssh://git@example.test/r.git"],
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("unsupported transport");
  });

  it("`remote remove <name>` deletes", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["remote", "remove", "origin"] });
    expect(calls.remoteRemove).toEqual([{ dir: "/", name: "origin" }]);
  });

  it("`remote rm <name>` is an alias for remove", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["remote", "rm", "origin"] });
    expect(calls.remoteRemove).toEqual([{ dir: "/", name: "origin" }]);
  });

  it("unknown remote subcommand is an error", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["remote", "sniff"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("unknown subcommand 'sniff'");
  });
});

describe("runGitCli — hash-object", () => {
  it("--stdin hashes the input stdin", async () => {
    const { client, calls } = fakeClient({}, { hashObject: () => "d".repeat(40) });
    const res = await runGitCli(client, {
      argv: ["hash-object", "--stdin"],
      cwd: "/r",
      stdin: "hello\n",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(`${"d".repeat(40)}\n`);
    expect(calls.hashObject).toEqual([{ dir: "/r", content: "hello\n", write: false }]);
  });

  it("-w writes the blob", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["hash-object", "-w", "--stdin"],
      stdin: "x",
    });
    expect(calls.hashObject[0].write).toBe(true);
  });

  it("without --stdin is an error", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["hash-object"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("only --stdin is supported");
  });
});

describe("runGitCli — cat-file", () => {
  it("-p <oid> reads the object's bytes", async () => {
    const { client, calls } = fakeClient(
      {},
      {
        catFile: () => ({
          oid: "a".repeat(40),
          bytes: new TextEncoder().encode("hello\n"),
        }),
      },
    );
    const res = await runGitCli(client, {
      argv: ["cat-file", "-p", "a".repeat(40)],
      cwd: "/r",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hello\n");
    expect(calls.catFile).toEqual([{ dir: "/r", oid: "a".repeat(40), filepath: undefined }]);
  });

  it("-p <oid>:<path> reads a tree subpath", async () => {
    const { client, calls } = fakeClient(
      {},
      {
        catFile: () => ({
          oid: "a".repeat(40),
          bytes: new TextEncoder().encode("world\n"),
        }),
      },
    );
    await runGitCli(client, {
      argv: ["cat-file", "-p", `${"a".repeat(40)}:a.txt`],
    });
    expect(calls.catFile[0]).toMatchObject({
      oid: "a".repeat(40),
      filepath: "a.txt",
    });
  });

  it("without -p is an error", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["cat-file", "a".repeat(40)] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("only -p is supported");
  });
});

describe("runGitCli — update-ref", () => {
  it("writes <ref> <value> through to the client", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["update-ref", "refs/heads/main", "a".repeat(40)],
      cwd: "/r",
    });
    expect(res.exitCode).toBe(0);
    expect(calls.updateRef).toEqual([
      {
        dir: "/r",
        ref: "refs/heads/main",
        value: "a".repeat(40),
        force: false,
      },
    ]);
  });

  it("--force flips the option", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["update-ref", "--force", "refs/heads/main", "a".repeat(40)],
    });
    expect(calls.updateRef[0].force).toBe(true);
  });

  it("missing arguments is an error", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["update-ref", "refs/heads/main"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("usage");
  });
});

describe("runGitCli — config", () => {
  it("`config <key>` returns the value", async () => {
    const { client } = fakeClient({}, { configGet: () => "test@x" });
    const res = await runGitCli(client, { argv: ["config", "user.email"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("test@x\n");
  });

  it("`config <key>` on missing key exits 1", async () => {
    const { client } = fakeClient({}, { configGet: () => undefined });
    const res = await runGitCli(client, { argv: ["config", "missing.key"] });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
  });

  it("`config --get-all <key>` returns multi-valued output", async () => {
    const { client, calls } = fakeClient({}, { configGet: () => ["a", "b"] });
    const res = await runGitCli(client, {
      argv: ["config", "--get-all", "remote.origin.fetch"],
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("a\nb\n");
    expect(calls.configGet[0].all).toBe(true);
  });

  it("`config <key> <value>` sets", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["config", "user.email", "a@x"],
      cwd: "/r",
    });
    expect(res.exitCode).toBe(0);
    expect(calls.configSet).toEqual([
      { dir: "/r", path: "user.email", value: "a@x", append: false },
    ]);
  });

  it("`config --add <key> <value>` appends to a multi-valued key", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["config", "--add", "remote.origin.fetch", "refs/heads/*"],
    });
    expect(calls.configSet[0].append).toBe(true);
  });

  it("`config --unset <key>` unsets", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["config", "--unset", "user.email"] });
    expect(calls.configSet[0].value).toBeUndefined();
  });
});

describe("runGitCli — stash argv parsing", () => {
  it("bare stash is a push", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["stash"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.stashPush).toEqual([{ dir: "/r", message: undefined }]);
  });

  it("stash push -m forwards the message", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["stash", "push", "-m", "wip"], cwd: "/r" });
    expect(calls.stashPush[0]).toMatchObject({ dir: "/r", message: "wip" });
  });

  it("stash list prints entries", async () => {
    const { client } = fakeClient({}, { stashList: () => ["stash@{0}: wip"] });
    const res = await runGitCli(client, { argv: ["stash", "list"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("stash@{0}: wip\n");
  });

  it("stash list with no entries prints nothing", async () => {
    const { client } = fakeClient({}, { stashList: () => [] });
    const res = await runGitCli(client, { argv: ["stash", "list"] });
    expect(res.stdout).toBe("");
  });

  it("stash pop restores the latest entry", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["stash", "pop"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.stashPop).toEqual([{ dir: "/r" }]);
  });

  it("unknown stash subcommand exits 129", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["stash", "bogus"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("unknown subcommand");
  });
});

describe("runGitCli — reset argv parsing", () => {
  it("path reset unstages the listed paths", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["reset", "--", "a.txt"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.reset[0]).toMatchObject({ dir: "/r", hard: false, paths: ["a.txt"] });
  });

  it("bare positionals without -- are treated as paths", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["reset", "a.txt", "b.txt"] });
    expect(calls.reset[0]).toMatchObject({ paths: ["a.txt", "b.txt"], hard: false });
  });

  it("--hard with a ref hard-resets to it", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["reset", "--hard", "HEAD"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.reset[0]).toMatchObject({ dir: "/r", hard: true, ref: "HEAD" });
  });

  it("--hard resolves a revision suffix in the ref", async () => {
    const { client, calls } = fakeClient({}, { revParse: () => "a".repeat(40) });
    await runGitCli(client, { argv: ["reset", "--hard", "HEAD~1"] });
    expect(calls.reset[0]).toMatchObject({ hard: true, ref: "a".repeat(40) });
  });

  it("--soft is rejected as unsupported", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["reset", "--soft", "HEAD"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("--soft is not supported");
  });

  it("--mixed is rejected as unsupported", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["reset", "--mixed", "HEAD"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("--mixed is not supported");
    expect(calls.reset).toEqual([]);
  });
});

describe("runGitCli — clean argv parsing", () => {
  it("refuses to run without -f", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["clean"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("refusing to clean without -f");
    expect(calls.clean).toEqual([]);
  });

  it("-fd removes untracked files and directories", async () => {
    const { client, calls } = fakeClient({}, { clean: () => ["build", "junk.txt"] });
    const res = await runGitCli(client, { argv: ["clean", "-fd"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.clean[0]).toMatchObject({ dir: "/r", directories: true, dryRun: false });
    expect(res.stdout).toBe("Removing build\nRemoving junk.txt\n");
  });

  it("-n / --dry-run previews without -f", async () => {
    const { client, calls } = fakeClient({}, { clean: () => ["junk.txt"] });
    const res = await runGitCli(client, { argv: ["clean", "-n", "-d"] });
    expect(res.exitCode).toBe(0);
    expect(calls.clean[0]).toMatchObject({ dryRun: true, directories: true });
    expect(res.stdout).toBe("Would remove junk.txt\n");
  });
});

// ---------------------------------------------------------------
// End-to-end: real Workspace + real isomorphic-git/diff, faked
// clone phase. Matches the pattern in clone.test.ts.
// ---------------------------------------------------------------

describe("runGitCli — end-to-end against an in-process Workspace", () => {
  it("diff prints the working-tree delta against HEAD", async () => {
    const ws = new Workspace({ git: createGitClient(), storage: new SQLiteTestStorage() });
    await ws.ready();

    // Seed a repo with one committed file, then mutate the
    // working tree. We drive isomorphic-git directly through the
    // workspace's FsClient adapter to avoid spinning up an HTTP
    // server.
    const { workspaceIsomorphicGitClient } = await import("./adapter.js");
    const fs = await workspaceIsomorphicGitClient(ws.provider());
    const dir = "/";
    await git.init({ fs: fs as unknown as object, dir, defaultBranch: "main" });
    await ws.fs.writeFile("/a.txt", "hello\n");
    await git.add({ fs: fs as unknown as object, dir, filepath: "a.txt" });
    await git.commit({
      fs: fs as unknown as object,
      dir,
      message: "init",
      author: { name: "t", email: "t@example.test" },
    });
    await ws.fs.writeFile("/a.txt", "hello world\n");

    const res = await ws.git.cli({ argv: ["diff"], cwd: "/" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--- a.txt");
    expect(res.stdout).toContain("+hello world");
    expect(res.stderr).toBe("");
  });

  it("init -> add -> commit -> status round-trip", async () => {
    // Drives the full family-1 surface through a real Workspace,
    // observing the side effects via subsequent CLI calls. If
    // any subcommand drifts from the typed surface, the chain
    // breaks here rather than in a downstream consumer.
    const ws = new Workspace({
      git: createGitClient(),
      storage: new SQLiteTestStorage(),
      defaultGitIdentity: { name: "Test", email: "test@example.test" },
    });
    await ws.ready();
    const cli = (argv: string[]) => ws.git.cli({ argv, cwd: "/" });

    const initRes = await cli(["init"]);
    expect(initRes.exitCode).toBe(0);
    expect(initRes.stdout).toContain("Initialized empty Git repository");

    await ws.fs.writeFile("/a.txt", "hello\n");
    // status before staging: one untracked entry.
    const status1 = await cli(["status", "--short"]);
    expect(status1.exitCode).toBe(0);
    expect(status1.stdout).toBe(" ? a.txt\n");

    const addRes = await cli(["add", "a.txt"]);
    expect(addRes.exitCode).toBe(0);
    const status2 = await cli(["status", "--short"]);
    // After `add`, isomorphic-git's statusMatrix reports the
    // workdir column as differs-from-HEAD (status 2) rather
    // than equal-to-stage, so the Y column reads 'M'. Real git
    // would refresh and produce 'A '. The XY pair is
    // deterministic; pin it.
    expect(status2.stdout).toBe("AM a.txt\n");

    const commitRes = await cli(["commit", "-m", "init"]);
    expect(commitRes.exitCode).toBe(0);
    expect(commitRes.stdout).toMatch(/^\[[0-9a-f]{7}\] init\n$/);

    // Working tree clean now.
    const status3 = await cli(["status"]);
    expect(status3.exitCode).toBe(0);
    expect(status3.stdout).toBe("");

    // A subsequent init fails with exit 128.
    const initAgain = await cli(["init"]);
    expect(initAgain.exitCode).toBe(128);
    expect(initAgain.stderr).toContain("already exists");
  });

  it("log / show / rev-parse / ls-files round-trip", async () => {
    const ws = new Workspace({
      git: createGitClient(),
      storage: new SQLiteTestStorage(),
      defaultGitIdentity: { name: "Test", email: "test@example.test" },
    });
    await ws.ready();
    const cli = (argv: string[]) => ws.git.cli({ argv, cwd: "/" });
    await cli(["init"]);
    await ws.fs.writeFile("/a.txt", "hello\n");
    await cli(["add", "a.txt"]);
    await cli(["commit", "-m", "first"]);
    await ws.fs.writeFile("/a.txt", "hello world longer\n");
    await cli(["add", "a.txt"]);
    await cli(["commit", "-m", "second"]);

    const log = await cli(["log", "--oneline"]);
    expect(log.exitCode).toBe(0);
    const lines = log.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^[0-9a-f]{7} second$/);
    expect(lines[1]).toMatch(/^[0-9a-f]{7} first$/);

    const revParse = await cli(["rev-parse", "HEAD"]);
    expect(revParse.exitCode).toBe(0);
    expect(revParse.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);

    const sym = await cli(["symbolic-ref", "--short", "HEAD"]);
    expect(sym.exitCode).toBe(0);
    expect(sym.stdout).toBe("main\n");

    const lsFiles = await cli(["ls-files"]);
    expect(lsFiles.exitCode).toBe(0);
    expect(lsFiles.stdout).toBe("a.txt\n");
  });

  it("hash-object / cat-file / update-ref / config round-trip", async () => {
    const ws = new Workspace({
      git: createGitClient(),
      storage: new SQLiteTestStorage(),
      defaultGitIdentity: { name: "Test", email: "test@example.test" },
    });
    await ws.ready();
    const cli = (argv: string[], opts: { stdin?: string } = {}) =>
      ws.git.cli({ argv, cwd: "/", stdin: opts.stdin });
    await cli(["init"]);

    // hash-object -w --stdin writes a blob and prints its oid.
    const hashed = await cli(["hash-object", "-w", "--stdin"], { stdin: "hello\n" });
    expect(hashed.exitCode).toBe(0);
    const oid = hashed.stdout.trim();
    expect(oid).toMatch(/^[0-9a-f]{40}$/);

    // cat-file -p reads the same bytes back.
    const read = await cli(["cat-file", "-p", oid]);
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toBe("hello\n");

    // config set + get round-trip.
    expect((await cli(["config", "user.name", "Test User"])).exitCode).toBe(0);
    const got = await cli(["config", "user.name"]);
    expect(got.exitCode).toBe(0);
    expect(got.stdout).toBe("Test User\n");

    // Make a commit so we have an oid to point a ref at.
    await ws.fs.writeFile("/a.txt", "hi\n");
    await cli(["add", "a.txt"]);
    await cli(["commit", "-m", "init"]);
    const headRes = await cli(["rev-parse", "HEAD"]);
    const head = headRes.stdout.trim();

    // update-ref moves a custom ref to HEAD.
    expect((await cli(["update-ref", "refs/custom/x", head])).exitCode).toBe(0);
    const custom = await cli(["rev-parse", "refs/custom/x"]);
    expect(custom.stdout.trim()).toBe(head);
  });

  it("remote add / list / remove round-trip through the config file", async () => {
    const ws = new Workspace({ git: createGitClient(), storage: new SQLiteTestStorage() });
    await ws.ready();
    const cli = (argv: string[]) => ws.git.cli({ argv, cwd: "/" });
    await cli(["init"]);

    expect((await cli(["remote", "add", "origin", "https://example.test/r.git"])).exitCode).toBe(0);
    expect((await cli(["remote", "add", "fork", "https://fork.example.test/r.git"])).exitCode).toBe(
      0,
    );

    const list = await cli(["remote"]);
    expect(list.stdout).toBe("fork\norigin\n");

    const verbose = await cli(["remote", "-v"]);
    expect(verbose.stdout).toContain("fork\thttps://fork.example.test/r.git (fetch)");
    expect(verbose.stdout).toContain("origin\thttps://example.test/r.git (push)");

    await cli(["remote", "remove", "fork"]);
    const after = await cli(["remote"]);
    expect(after.stdout).toBe("origin\n");
  });

  it("branch / checkout / tag round-trip moves HEAD and creates refs", async () => {
    const ws = new Workspace({
      git: createGitClient(),
      storage: new SQLiteTestStorage(),
      defaultGitIdentity: { name: "Test", email: "test@example.test" },
    });
    await ws.ready();
    const cli = (argv: string[]) => ws.git.cli({ argv, cwd: "/" });
    await cli(["init"]);
    await ws.fs.writeFile("/a.txt", "hello\n");
    await cli(["add", "a.txt"]);
    await cli(["commit", "-m", "init"]);

    // Create and switch to a feature branch.
    expect((await cli(["branch", "feature"])).exitCode).toBe(0);
    expect((await cli(["checkout", "feature"])).exitCode).toBe(0);
    const sym = await cli(["symbolic-ref", "--short", "HEAD"]);
    expect(sym.stdout).toBe("feature\n");

    // Tag the current commit.
    expect((await cli(["tag", "v1.0"])).exitCode).toBe(0);
    const tags = await cli(["tag"]);
    expect(tags.stdout).toBe("v1.0\n");

    // Bare branch listing marks the current with '* '.
    const branches = await cli(["branch"]);
    expect(branches.stdout.split("\n").filter(Boolean).sort()).toEqual(["  main", "* feature"]);

    // Switching back and deleting feature.
    await cli(["checkout", "main"]);
    expect((await cli(["branch", "-d", "feature"])).exitCode).toBe(0);
    const branches2 = await cli(["branch"]);
    expect(branches2.stdout).toBe("* main\n");
  });

  it("switch restores tracked file content from the target branch", async () => {
    const ws = new Workspace({
      git: createGitClient(),
      storage: new SQLiteTestStorage(),
      defaultGitIdentity: { name: "Test", email: "test@example.test" },
    });
    await ws.ready();
    const cli = (argv: string[]) => ws.git.cli({ argv, cwd: "/" });
    await cli(["init"]);
    await ws.fs.writeFile("/a.txt", "main\n");
    await cli(["add", "a.txt"]);
    await cli(["commit", "-m", "main"]);

    await cli(["switch", "-c", "feature"]);
    await ws.fs.writeFile("/a.txt", "feature\n");
    await cli(["commit", "-am", "feature"]);

    const switched = await cli(["switch", "main"]);
    expect(switched.exitCode, switched.stderr).toBe(0);
    expect(await ws.fs.readFile("/a.txt", "utf8")).toBe("main\n");
    expect((await cli(["branch", "--show-current"])).stdout).toBe("main\n");
  });

  it("reset HEAD unstages all staged changes", async () => {
    const ws = new Workspace({
      git: createGitClient(),
      storage: new SQLiteTestStorage(),
      defaultGitIdentity: { name: "Test", email: "test@example.test" },
    });
    await ws.ready();
    const cli = (argv: string[]) => ws.git.cli({ argv, cwd: "/" });
    await cli(["init"]);
    await ws.fs.writeFile("/a.txt", "one\n");
    await cli(["add", "a.txt"]);
    await cli(["commit", "-m", "init"]);

    await ws.fs.writeFile("/a.txt", "two\n");
    await ws.fs.writeFile("/b.txt", "new\n");
    await cli(["add", "-A"]);
    expect((await cli(["status", "--porcelain=v1"])).stdout).toContain("A");

    const reset = await cli(["reset", "HEAD"]);
    expect(reset.exitCode, reset.stderr).toBe(0);
    expect((await cli(["status", "--porcelain=v1"])).stdout).toContain("?? b.txt\n");
  });

  it("commit without identity surfaces as exit 128", async () => {
    const ws = new Workspace({ git: createGitClient(), storage: new SQLiteTestStorage() });
    await ws.ready();
    await ws.git.cli({ argv: ["init"], cwd: "/" });
    await ws.fs.writeFile("/a.txt", "x\n");
    await ws.git.cli({ argv: ["add", "a.txt"], cwd: "/" });
    const res = await ws.git.cli({ argv: ["commit", "-m", "x"], cwd: "/" });
    expect(res.exitCode).toBe(128);
    expect(res.stderr).toContain("author identity unknown");
  });

  it("agent edit/commit loop: config identity, -A, commit -am, diff --stat, switch -c", async () => {
    // Exercises the Phase 1-4 surface end to end through the
    // shell-facing CLI against a real Workspace, the way an agent
    // would drive it: configure identity, stage with -A, commit
    // with -am, inspect with the new flags, branch with switch
    // -c, then reset / stash / clean.
    const ws = new Workspace({ git: createGitClient(), storage: new SQLiteTestStorage() });
    await ws.ready();
    const cli = (argv: string[]) => ws.git.cli({ argv, cwd: "/" });

    await cli(["init"]);
    // Identity comes from local config, not a default identity.
    expect((await cli(["config", "user.name", "Agent"])).exitCode).toBe(0);
    expect((await cli(["config", "user.email", "agent@example.test"])).exitCode).toBe(0);

    // -A stages a brand new file; commit reads the config identity.
    await ws.fs.writeFile("/a.txt", "one\n");
    expect((await cli(["add", "-A"])).exitCode).toBe(0);
    const c1 = await cli(["commit", "-m", "init"]);
    expect(c1.exitCode, c1.stderr).toBe(0);

    // branch --show-current works on the symbolic HEAD.
    expect((await cli(["branch", "--show-current"])).stdout).toBe("main\n");
    // rev-parse --show-toplevel finds the root.
    expect((await cli(["rev-parse", "--show-toplevel"])).stdout).toBe("/\n");

    // Modify the tracked file and commit with -am in one step.
    await ws.fs.writeFile("/a.txt", "one\ntwo\n");
    const c2 = await cli(["commit", "-am", "second"]);
    expect(c2.exitCode, c2.stderr).toBe(0);

    // diff --stat / --name-only against the previous commit via a
    // revision suffix.
    const stat = await cli(["diff", "--stat", "HEAD~1", "HEAD"]);
    expect(stat.exitCode).toBe(0);
    expect(stat.stdout).toContain("a.txt");
    expect(stat.stdout).toContain("1 file changed");
    const names = await cli(["diff", "--name-only", "HEAD~1", "HEAD"]);
    expect(names.stdout).toBe("a.txt\n");

    // log -1 --oneline shorthand.
    const log = await cli(["log", "-1", "--oneline"]);
    expect(log.stdout.trim()).toMatch(/^[0-9a-f]{7} second$/);

    // switch -c creates and moves onto a new branch.
    expect((await cli(["switch", "-c", "feature"])).exitCode).toBe(0);
    expect((await cli(["branch", "--show-current"])).stdout).toBe("feature\n");

    // Stage a change, then reset --hard restores it.
    await ws.fs.writeFile("/a.txt", "dirty\n");
    await cli(["add", "-A"]);
    expect((await cli(["reset", "--hard", "HEAD"])).exitCode).toBe(0);
    expect(await ws.fs.readFile("/a.txt", "utf8")).toBe("one\ntwo\n");

    // reset --hard to an ancestor restores content and keeps HEAD attached.
    const resetAncestor = await cli(["reset", "--hard", "HEAD~1"]);
    expect(resetAncestor.exitCode, resetAncestor.stderr).toBe(0);
    expect(await ws.fs.readFile("/a.txt", "utf8")).toBe("one\n");
    expect((await cli(["branch", "--show-current"])).stdout).toBe("feature\n");

    // stash pushes a dirty tracked change, lists it, and pops it back.
    await ws.fs.writeFile("/a.txt", "stashed\n");
    const stash = await cli(["stash", "push", "-m", "wip"]);
    expect(stash.exitCode, stash.stderr).toBe(0);
    expect(await ws.fs.readFile("/a.txt", "utf8")).toBe("one\n");
    expect((await cli(["stash", "list"])).stdout).toContain("wip");
    const pop = await cli(["stash", "pop"]);
    expect(pop.exitCode, pop.stderr).toBe(0);
    expect(await ws.fs.readFile("/a.txt", "utf8")).toBe("stashed\n");
    expect((await cli(["reset", "--hard", "HEAD"])).exitCode).toBe(0);

    // clean -fd removes untracked junk.
    await ws.fs.writeFile("/junk.txt", "junk\n");
    const clean = await cli(["clean", "-fd"]);
    expect(clean.exitCode).toBe(0);
    expect(clean.stdout).toContain("Removing junk.txt");
    const statusAfter = await cli(["status", "--porcelain=v1"]);
    expect(statusAfter.stdout).toBe("");
  });

  it("a clone failure surfaces as exit 1 on stderr", async () => {
    // Force the clone path to fail by pointing at an invalid host;
    // we want to pin that the dispatcher's catch arm produces a
    // CLI-shaped result and doesn't propagate the rejection.
    const ws = new Workspace({ git: createGitClient(), storage: new SQLiteTestStorage() });
    await ws.ready();
    // Swap the git client out for one whose clone rejects, so we
    // don't depend on network reachability inside the test runner.
    const failing: GitClient = createGitClient({
      adapter: async () => ({
        promises: {
          readFile: vi.fn(async () => new Uint8Array()),
        },
      }),
    })({ ws });
    // Replace `clone` with a deterministic failure — the real
    // path is exercised by `clone.test.ts`.
    (failing as { clone: GitClient["clone"] }).clone = async () => {
      throw new Error("could not resolve host");
    };
    const res = await failing.cli({ argv: ["clone", "https://invalid.test/x.git"] });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("could not resolve host");
    expect(res.stdout).toBe("");
  });
});
