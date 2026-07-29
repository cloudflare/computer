// Tests for `defineGitCommand` — the bridge between just-bash's
// custom-command surface and the host workspace's
// `workspace.git.cli(...)`.
//
// The command is intentionally thin. The argv parser, every
// behavioural choice for the CLI, and the per-subcommand error
// shape live in `git/cli.ts` and are covered there. What's worth
// pinning here is the bridging contract: argv forwarding without
// reparsing, stdin decoded once on the way through, env Map
// flattened to a plain object, and a host-RPC throw producing a
// shell-shaped exit 1 instead of poisoning the pipeline.

import { encodeUtf8ToBytes } from "just-bash";
import { describe, expect, it, vi } from "vitest";

import type { GitCliInput, GitCliResult } from "../../git/index.js";
import { defineGitCommand, type GitCommandHost } from "./git-command.js";

function fakeHost(impl: (input: GitCliInput) => Promise<GitCliResult> | GitCliResult): {
  host: GitCommandHost;
  calls: GitCliInput[];
} {
  const calls: GitCliInput[] = [];
  return {
    calls,
    host: {
      git: {
        cli: vi.fn(async (input) => {
          calls.push(input);
          return await impl(input);
        }),
      },
    },
  };
}

function makeCtx(overrides: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}) {
  const env = new Map<string, string>(Object.entries(overrides.env ?? {}));
  return {
    fs: {} as never,
    cwd: overrides.cwd ?? "/workspace",
    env,
    stdin: encodeUtf8ToBytes(overrides.stdin ?? ""),
  };
}

describe("defineGitCommand", () => {
  it("registers under the name 'git'", () => {
    const { host } = fakeHost(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cmd = defineGitCommand(host);
    expect(cmd.name).toBe("git");
  });

  it("forwards argv verbatim (no reparsing, no shell splitting)", async () => {
    // Bash has already split the command line into argv by the
    // time a custom command is invoked. The git custom command
    // must not re-split or unquote — the CLI dispatcher owns
    // every argv-shape decision.
    const { host, calls } = fakeHost(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const cmd = defineGitCommand(host);
    await cmd.execute(
      ["clone", "--depth=1", "--branch", "main", "https://example.test/r.git"],
      makeCtx({ cwd: "/work" }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual([
      "clone",
      "--depth=1",
      "--branch",
      "main",
      "https://example.test/r.git",
    ]);
    expect(calls[0].cwd).toBe("/work");
  });

  it("flattens the env Map into a plain object", async () => {
    const { host, calls } = fakeHost(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const cmd = defineGitCommand(host);
    await cmd.execute(
      ["status"],
      makeCtx({
        env: {
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "t@example.test",
          PATH: "/usr/bin",
        },
      }),
    );
    expect(calls[0].env).toEqual({
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@example.test",
      PATH: "/usr/bin",
    });
  });

  it("decodes stdin to UTF-8 once on the way through", async () => {
    // The CLI dispatcher takes stdin as a string. ctx.stdin is a
    // ByteString; the command must run it through
    // decodeBytesToUtf8 so the dispatcher doesn't see latin1
    // mojibake for multibyte input.
    const { host, calls } = fakeHost(() => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const cmd = defineGitCommand(host);
    await cmd.execute(["hash-object", "--stdin"], makeCtx({ stdin: "héllo\n" }));
    expect(calls[0].stdin).toBe("héllo\n");
  });

  it("returns the CLI result's stdout / stderr / exitCode verbatim", async () => {
    const { host } = fakeHost(() => ({
      stdout: "ok\n",
      stderr: "warn\n",
      exitCode: 7,
    }));
    const cmd = defineGitCommand(host);
    const res = await cmd.execute(["diff"], makeCtx());
    expect(res).toMatchObject({ stdout: "ok\n", stderr: "warn\n", exitCode: 7 });
  });

  it("surfaces a host RPC throw as exit 1 with the message on stderr", async () => {
    // If the workspace stub is gone (transport hiccup, parent
    // disposed mid-call) the cli() call rejects. The shell should
    // see a normal command failure, not a thrown exception that
    // poisons the rest of the pipeline.
    const { host } = fakeHost(() => {
      throw new Error("workspace stub disposed");
    });
    const cmd = defineGitCommand(host);
    const res = await cmd.execute(["status"], makeCtx());
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("workspace stub disposed");
    expect(res.stdout).toBe("");
  });
});
