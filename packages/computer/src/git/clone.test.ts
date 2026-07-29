// Tests for `@cloudflare/computer/git`'s `cloneWith` wrapper.
//
// `cloneWith` is fundamentally an option-translator: it sets a
// handful of defaults, splits the user's request into a
// `git.clone({ noCheckout: true })` followed by a
// `git.checkout({ filepaths })`, and forwards everything else
// through. The tests here cover that translation surface, plus
// one behavioural check that the two-phase model actually delivers
// a subset checkout when run against real isomorphic-git on memfs.

import git from "isomorphic-git";
import { fs as memfs, vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloneWith, type IsomorphicGitClient } from "./clone.js";

type CloneArgs = Parameters<IsomorphicGitClient["clone"]>[0];
type CheckoutArgs = Parameters<IsomorphicGitClient["checkout"]>[0];

function fakeGit() {
  const cloneCalls: CloneArgs[] = [];
  const checkoutCalls: CheckoutArgs[] = [];
  const git: IsomorphicGitClient = {
    clone: vi.fn(async (args: CloneArgs) => {
      cloneCalls.push(args);
    }),
    checkout: vi.fn(async (args: CheckoutArgs) => {
      checkoutCalls.push(args);
    }),
  };
  return { git, cloneCalls, checkoutCalls };
}

// FsClient and HttpClient are opaque collaborators for cloneWith;
// it never inspects them, only forwards.
const fakeFs: object = { __brand: "fake-fs" };
const fakeHttp: object = { __brand: "fake-http" };

describe("cloneWith option translation", () => {
  it("splits the request into a noCheckout clone and a checkout, with sensible defaults", async () => {
    const { git, cloneCalls, checkoutCalls } = fakeGit();

    await cloneWith({
      git,
      http: fakeHttp,
      fs: fakeFs,
      url: "https://example.test/repo.git",
    });

    expect(cloneCalls).toEqual([
      expect.objectContaining({
        fs: fakeFs,
        http: fakeHttp,
        url: "https://example.test/repo.git",
        dir: "/",
        depth: 1,
        singleBranch: true,
        noTags: true,
        noCheckout: true,
      }),
    ]);
    expect(checkoutCalls).toEqual([
      expect.objectContaining({
        fs: fakeFs,
        dir: "/",
        ref: "HEAD",
        force: true,
        filepaths: undefined,
      }),
    ]);
  });

  it("forwards explicit ref, depth, dir, singleBranch, noTags, headers, corsProxy, paths, and hooks", async () => {
    const { git, cloneCalls, checkoutCalls } = fakeGit();
    const onProgress = vi.fn();
    const onMessage = vi.fn();

    await cloneWith({
      git,
      http: fakeHttp,
      fs: fakeFs,
      url: "https://example.test/repo.git",
      dir: "/work",
      ref: "develop",
      depth: 5,
      singleBranch: false,
      noTags: false,
      headers: { Authorization: "Bearer xyz" },
      corsProxy: "https://cors.example.test",
      paths: ["README.md", "packages/foo"],
      onProgress,
      onMessage,
    });

    expect(cloneCalls[0]).toMatchObject({
      dir: "/work",
      ref: "develop",
      depth: 5,
      singleBranch: false,
      noTags: false,
      headers: { Authorization: "Bearer xyz" },
      corsProxy: "https://cors.example.test",
      onProgress,
      onMessage,
    });
    // `paths` is a checkout-phase concern; isomorphic-git's clone()
    // has no filepaths option and silently dropping unknown keys
    // would be brittle, so verify it does not leak.
    expect(cloneCalls[0]).not.toHaveProperty("filepaths");
    expect(cloneCalls[0]).not.toHaveProperty("paths");
    expect(checkoutCalls[0]).toMatchObject({
      dir: "/work",
      ref: "develop",
      filepaths: ["README.md", "packages/foo"],
    });
  });

  it("omits depth when full history is requested (depth=0 or Infinity)", async () => {
    for (const depth of [0, Number.POSITIVE_INFINITY]) {
      const { git, cloneCalls } = fakeGit();
      await cloneWith({
        git,
        http: fakeHttp,
        fs: fakeFs,
        url: "https://example.test/repo.git",
        depth,
      });
      expect(cloneCalls[0].depth, `depth=${depth}`).toBeUndefined();
    }
  });

  it("forwards a shared cache to both phases", async () => {
    const { git, cloneCalls, checkoutCalls } = fakeGit();
    const cache = {};
    await cloneWith({
      git,
      http: fakeHttp,
      fs: fakeFs,
      url: "https://example.test/repo.git",
      cache,
    });
    expect(cloneCalls[0].cache).toBe(cache);
    expect(checkoutCalls[0].cache).toBe(cache);
  });

  it("propagates errors from the clone phase and never runs checkout", async () => {
    const boom = new Error("upload-pack 502");
    const git: IsomorphicGitClient = {
      clone: vi.fn(async () => {
        throw boom;
      }),
      checkout: vi.fn(async () => {}),
    };

    await expect(
      cloneWith({
        git,
        http: fakeHttp,
        fs: fakeFs,
        url: "https://example.test/repo.git",
      }),
    ).rejects.toBe(boom);

    expect(git.checkout).not.toHaveBeenCalled();
  });
});

// The HTTP side of `git.clone` is not easy to fake without a
// real packfile fixture, so this test exercises only the
// noCheckout+checkout-with-filepaths handshake that backs the
// subset-checkout promise. The clone phase is faked: a real
// `git.init` + commit produces the same on-disk state a
// `noCheckout: true` clone would leave behind (refs and objects
// populated, working tree empty), and `cloneWith` then drives
// real `git.checkout` against it.
describe("cloneWith subset checkout (real isomorphic-git + memfs)", () => {
  const DIR = "/repo";
  const AUTHOR = { name: "test", email: "t@example.test" };

  beforeEach(() => {
    vol.reset();
  });

  it("materializes only the requested paths into the working tree", async () => {
    // Build a repo with three files and commit them, then strip
    // the working tree so the state mirrors a fresh `clone({
    // noCheckout: true })`.
    await memfs.promises.mkdir(DIR, { recursive: true });
    await git.init({ fs: memfs, dir: DIR, defaultBranch: "main" });
    for (const [name, content] of [
      ["README.md", "readme\n"],
      ["keep/file.txt", "keep\n"],
      ["drop/file.txt", "drop\n"],
    ] as const) {
      const full = `${DIR}/${name}`;
      const idx = full.lastIndexOf("/");
      await memfs.promises.mkdir(full.slice(0, idx), { recursive: true });
      await memfs.promises.writeFile(full, content);
      await git.add({ fs: memfs, dir: DIR, filepath: name });
    }
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });

    // Strip the working tree but keep `.git/`.
    for (const name of ["README.md", "keep", "drop"]) {
      await memfs.promises.rm(`${DIR}/${name}`, { recursive: true });
    }

    // A clone module whose `clone` is a no-op (the repo is already
    // populated above), but whose `checkout` is the real one.
    const fakeClone: IsomorphicGitClient = {
      clone: vi.fn(async () => {}),
      checkout: (args) => git.checkout({ ...args, fs: memfs }) as unknown as Promise<void>,
    };

    await cloneWith({
      git: fakeClone,
      http: fakeHttp,
      fs: memfs,
      url: "ignored — clone phase is faked",
      dir: DIR,
      paths: ["README.md", "keep"],
    });

    // Requested paths are present.
    expect(await memfs.promises.readFile(`${DIR}/README.md`, "utf8")).toBe("readme\n");
    expect(await memfs.promises.readFile(`${DIR}/keep/file.txt`, "utf8")).toBe("keep\n");

    // The un-requested path stays absent. isomorphic-git's
    // `checkout` writes only the requested filepaths to disk.
    await expect(memfs.promises.stat(`${DIR}/drop/file.txt`)).rejects.toThrow();
  });

  it("leaves HEAD as a symbolic ref after checkout", async () => {
    // Reproduce the post-clone on-disk state: clone writes a
    // symbolic HEAD pointing at the fetched branch, then leaves
    // checkout to materialize the tree. Build that state with a
    // real init + commit (which sets HEAD -> refs/heads/main),
    // strip the working tree, and drive cloneWith's checkout
    // phase against it. The checkout must not detach HEAD.
    await memfs.promises.mkdir(DIR, { recursive: true });
    await git.init({ fs: memfs, dir: DIR, defaultBranch: "main" });
    await memfs.promises.writeFile(`${DIR}/README.md`, "readme\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "README.md" });
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });
    await memfs.promises.rm(`${DIR}/README.md`);

    const fakeClone: IsomorphicGitClient = {
      clone: vi.fn(async () => {}),
      checkout: (args) => git.checkout({ ...args, fs: memfs }) as unknown as Promise<void>,
    };

    await cloneWith({
      git: fakeClone,
      http: fakeHttp,
      fs: memfs,
      url: "ignored — clone phase is faked",
      dir: DIR,
    });

    const head = await memfs.promises.readFile(`${DIR}/.git/HEAD`, "utf8");
    expect(head.trim()).toBe("ref: refs/heads/main");
    expect(await git.currentBranch({ fs: memfs, dir: DIR })).toBe("main");
    // The working tree is still materialized.
    expect(await memfs.promises.readFile(`${DIR}/README.md`, "utf8")).toBe("readme\n");
  });
});
