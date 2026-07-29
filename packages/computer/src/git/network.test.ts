// Tests for the network family. Two layers:
//
//   1. Option forwarding for fetch / push / pull / merge. The
//      network primitives are exercised against a fake
//      isomorphic-git client; the assertions land on which args
//      reach the underlying call. A real upload-pack server is
//      out of scope; the option translation is the bit most
//      likely to drift.
//
//   2. Remote management end-to-end against real isomorphic-git
//      + memfs: addRemote, listRemotes, deleteRemote round-trip
//      through the on-disk config file.

import git from "isomorphic-git";
import { fs as memfs, vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MissingIdentityError } from "./errors.js";
import {
  fetchWith,
  type IsomorphicGitNetworkClient,
  mergeWith,
  pullWith,
  pushWith,
  remoteAddWith,
  remoteListWith,
  remoteRemoveWith,
} from "./network.js";

function fakeNetworkGit(): {
  git: IsomorphicGitNetworkClient;
  calls: Record<string, unknown[][]>;
} {
  const calls: Record<string, unknown[][]> = {
    fetch: [],
    push: [],
    pull: [],
    merge: [],
    addRemote: [],
    deleteRemote: [],
    listRemotes: [],
  };
  const git: IsomorphicGitNetworkClient = {
    fetch: vi.fn(async (args) => {
      calls.fetch.push([args]);
      return { defaultBranch: "main", fetchHead: "deadbeef" };
    }),
    push: vi.fn(async (args) => {
      calls.push.push([args]);
      return { ok: true, error: null, refs: {} };
    }),
    pull: vi.fn(async (args) => {
      calls.pull.push([args]);
    }),
    merge: vi.fn(async (args) => {
      calls.merge.push([args]);
      return { fastForward: true, oid: "f".repeat(40) };
    }),
    addRemote: vi.fn(async (args) => {
      calls.addRemote.push([args]);
    }),
    deleteRemote: vi.fn(async (args) => {
      calls.deleteRemote.push([args]);
    }),
    listRemotes: vi.fn(async (args) => {
      calls.listRemotes.push([args]);
      return [];
    }),
  };
  return { git, calls };
}

const fakeFs = {} as object;
const fakeHttp = {} as object;

describe("fetchWith forwarding", () => {
  it("forwards remote, ref, depth, prune, headers, onAuth", async () => {
    const { git, calls } = fakeNetworkGit();
    const onAuth = vi.fn();
    await fetchWith({
      git,
      fs: fakeFs,
      http: fakeHttp,
      dir: "/r",
      remote: "origin",
      ref: "main",
      depth: 5,
      prune: true,
      headers: { Authorization: "Bearer xyz" },
      onAuth,
    });
    expect(calls.fetch[0][0]).toMatchObject({
      dir: "/r",
      remote: "origin",
      ref: "main",
      depth: 5,
      prune: true,
      headers: { Authorization: "Bearer xyz" },
      onAuth,
    });
  });
});

describe("pushWith forwarding", () => {
  it("forwards force, delete, headers", async () => {
    const { git, calls } = fakeNetworkGit();
    const result = await pushWith({
      git,
      fs: fakeFs,
      http: fakeHttp,
      dir: "/r",
      remote: "origin",
      ref: "main",
      force: true,
      delete: false,
      headers: { Authorization: "x" },
    });
    expect(result.ok).toBe(true);
    expect(calls.push[0][0]).toMatchObject({
      remote: "origin",
      ref: "main",
      force: true,
      delete: false,
      headers: { Authorization: "x" },
    });
  });

  it("returns the underlying PushResult unchanged", async () => {
    const git: IsomorphicGitNetworkClient = {
      ...fakeNetworkGit().git,
      push: async () => ({
        ok: false,
        error: "non-fast-forward",
        refs: { "refs/heads/main": { ok: false, error: "non-fast-forward" } },
      }),
    };
    const result = await pushWith({
      git,
      fs: fakeFs,
      http: fakeHttp,
      dir: "/r",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("non-fast-forward");
  });
});

describe("pullWith identity resolution", () => {
  it("forwards explicit author and committer", async () => {
    const { git, calls } = fakeNetworkGit();
    await pullWith({
      git,
      fs: fakeFs,
      http: fakeHttp,
      dir: "/r",
      author: { name: "A", email: "a@x" },
      committer: { name: "C", email: "c@x" },
    });
    expect(calls.pull[0][0]).toMatchObject({
      author: { name: "A", email: "a@x" },
      committer: { name: "C", email: "c@x" },
    });
  });

  it("falls back to env GIT_AUTHOR_*", async () => {
    const { git, calls } = fakeNetworkGit();
    await pullWith({
      git,
      fs: fakeFs,
      http: fakeHttp,
      dir: "/r",
      env: { GIT_AUTHOR_NAME: "Env", GIT_AUTHOR_EMAIL: "env@x" },
    });
    expect(calls.pull[0][0]).toMatchObject({
      author: { name: "Env", email: "env@x" },
    });
  });

  it("falls back to defaultIdentity", async () => {
    const { git, calls } = fakeNetworkGit();
    await pullWith({
      git,
      fs: fakeFs,
      http: fakeHttp,
      dir: "/r",
      defaultIdentity: { name: "Default", email: "d@x" },
    });
    expect(calls.pull[0][0]).toMatchObject({
      author: { name: "Default", email: "d@x" },
    });
  });

  it("maps a MissingNameError-shaped throw to MissingIdentityError", async () => {
    const git: IsomorphicGitNetworkClient = {
      ...fakeNetworkGit().git,
      pull: async () => {
        const e = new Error("MissingNameError: name is required");
        throw e;
      },
    };
    await expect(pullWith({ git, fs: fakeFs, http: fakeHttp, dir: "/r" })).rejects.toBeInstanceOf(
      MissingIdentityError,
    );
  });
});

describe("mergeWith", () => {
  it("forwards theirs / ours / fast-forward flags", async () => {
    const { git, calls } = fakeNetworkGit();
    await mergeWith({
      git,
      fs: fakeFs,
      dir: "/r",
      theirs: "feature",
      ours: "main",
      fastForwardOnly: true,
      author: { name: "A", email: "a@x" },
    });
    expect(calls.merge[0][0]).toMatchObject({
      theirs: "feature",
      ours: "main",
      fastForwardOnly: true,
      author: { name: "A", email: "a@x" },
    });
  });

  it("returns the underlying merge result unchanged", async () => {
    const git: IsomorphicGitNetworkClient = {
      ...fakeNetworkGit().git,
      merge: async () => ({ alreadyMerged: true }),
    };
    const r = await mergeWith({ git, fs: fakeFs, dir: "/r", theirs: "x" });
    expect(r.alreadyMerged).toBe(true);
  });
});

describe("remote add/list/remove end-to-end (real isomorphic-git + memfs)", () => {
  beforeEach(() => vol.reset());

  it("adds, lists, and removes remotes through the on-disk config", async () => {
    await memfs.promises.mkdir("/repo", { recursive: true });
    await git.init({ fs: memfs, dir: "/repo", defaultBranch: "main" });
    const isogit = git as unknown as IsomorphicGitNetworkClient;

    await remoteAddWith({
      git: isogit,
      fs: memfs,
      dir: "/repo",
      name: "origin",
      url: "https://example.test/r.git",
    });
    await remoteAddWith({
      git: isogit,
      fs: memfs,
      dir: "/repo",
      name: "fork",
      url: "https://fork.example.test/r.git",
    });
    const list = await remoteListWith({ git: isogit, fs: memfs, dir: "/repo" });
    expect(list.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "fork", url: "https://fork.example.test/r.git" },
      { name: "origin", url: "https://example.test/r.git" },
    ]);

    await remoteRemoveWith({
      git: isogit,
      fs: memfs,
      dir: "/repo",
      name: "fork",
    });
    const after = await remoteListWith({ git: isogit, fs: memfs, dir: "/repo" });
    expect(after).toEqual([{ name: "origin", url: "https://example.test/r.git" }]);
  });
});
