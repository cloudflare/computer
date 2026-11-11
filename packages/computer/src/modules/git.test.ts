import { describe, expect, it } from "vitest";

import { isUnsafeToRepeat } from "../runtime/replay-safety";
import type { WorkspaceModuleCallContext, WorkspaceModuleHost } from "../runtime/types";
import { createGitModule, type GitModuleOptions } from "./git";

function fakeGit() {
  const calls: Array<{ method: string; options: unknown }> = [];
  const record =
    (method: string, result: unknown = null) =>
    async (options: unknown) => {
      calls.push({ method, options });
      return result;
    };
  return {
    calls,
    git: {
      fetch: record("fetch", { defaultBranch: "main", fetchHead: "abc" }),
      pull: record("pull", undefined),
      push: record("push", { ok: true, error: null, refs: {} }),
      cli: record("cli", { stdout: "", stderr: "", exitCode: 0 }),
    },
  };
}

function build(options: GitModuleOptions = { allowNetwork: true }) {
  const { calls, git } = fakeGit();
  // SAFETY: The functions under test only call fetch, pull, push and cli.
  const host = { git, artifacts: undefined, runtime: undefined } as unknown as WorkspaceModuleHost;
  return { calls, functions: createGitModule(options)(host) };
}

function callContext(access: "read" | "read-write" = "read-write"): WorkspaceModuleCallContext {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    access,
    callId: "test-call",
    execution: { id: "test-run", metadata: {} },
    interrupt: () => Promise.reject(new Error("not used")),
    resolvePath: async (path) => `/root/${path.replace(/^\/+/, "")}`,
  };
}

const headers = { Authorization: "Bearer token" };

describe("createGitModule network functions", () => {
  it("passes fetch, pull and push to the Git client with headers and a confined dir", async () => {
    const { calls, functions } = build();

    await expect(
      functions.fetch?.([{ dir: "repo", remote: "origin", ref: "main", headers }], callContext()),
    ).resolves.toEqual({ defaultBranch: "main", fetchHead: "abc" });
    await expect(
      functions.pull?.([{ dir: "repo", ref: "main", headers }], callContext()),
    ).resolves.toBeNull();
    await expect(
      functions.push?.([{ dir: "repo", ref: "topic", force: true, headers }], callContext()),
    ).resolves.toEqual({ ok: true, error: null, refs: {} });

    expect(calls).toEqual([
      {
        method: "fetch",
        options: { dir: "/root/repo", remote: "origin", ref: "main", headers },
      },
      { method: "pull", options: { dir: "/root/repo", ref: "main", headers } },
      { method: "push", options: { dir: "/root/repo", ref: "topic", force: true, headers } },
    ]);
  });

  it("passes cli headers through to the Git client", async () => {
    const { calls, functions } = build();

    await functions.cli?.(
      [{ argv: ["-C", "repo", "push", "origin", "main"], cwd: "/", headers }],
      callContext(),
    );

    expect(calls).toEqual([
      {
        method: "cli",
        options: { argv: ["push", "origin", "main"], cwd: "/root/repo", headers },
      },
    ]);
  });

  it("denies fetch, pull and push without allowNetwork", async () => {
    const { calls, functions } = build({});

    for (const name of ["fetch", "pull", "push"] as const) {
      await expect(functions[name]?.([{ dir: "repo" }], callContext())).rejects.toThrow(
        "requires createGitModule({ allowNetwork: true })",
      );
    }
    expect(calls).toEqual([]);
  });

  it("denies fetch, pull and push on a read-only backend", async () => {
    const { calls, functions } = build();

    for (const name of ["fetch", "pull", "push"] as const) {
      await expect(functions[name]?.([{ dir: "repo" }], callContext("read"))).rejects.toThrow(
        "requires Workspace write access",
      );
    }
    expect(calls).toEqual([]);
  });

  it("marks push as unsafe to repeat", () => {
    const { functions } = build();

    expect(isUnsafeToRepeat(functions.push)).toBe(true);
    expect(isUnsafeToRepeat(functions.fetch)).toBe(false);
    expect(isUnsafeToRepeat(functions.pull)).toBe(false);
  });

  it("describes headers only when the network is allowed", () => {
    expect(createGitModule({ allowNetwork: true }).description).toContain("`headers`");
    expect(createGitModule().description).not.toContain("`headers`");
    expect(createGitModule().description).toContain("are not allowed");
  });
});
