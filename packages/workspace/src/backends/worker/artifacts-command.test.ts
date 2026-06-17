// Tests for `defineArtifactsCommand` — the bridge between
// just-bash's custom-command surface and a host artifacts client's
// `artifacts.cli(...)`.
//
// Like the git command, this bridge is intentionally thin. The argv
// parser and every behavioral choice live in `artifacts/cli.ts`
// and are covered there. What's pinned here is the bridging
// contract: argv forwarded without reparsing, env Map flattened to
// a plain object, and a host-RPC throw producing a shell-shaped
// exit 1 instead of poisoning the pipeline.

import { encodeUtf8ToBytes as encodeUTF8ToBytes } from "just-bash";
import { describe, expect, it, vi } from "vitest";

import type { ArtifactsCLIInput, ArtifactsCLIResult } from "../../artifacts/index.js";
import { type ArtifactsCommandHost, defineArtifactsCommand } from "./artifacts-command.js";

function fakeHost(
  impl: (input: ArtifactsCLIInput) => Promise<ArtifactsCLIResult> | ArtifactsCLIResult,
): {
  host: ArtifactsCommandHost;
  calls: ArtifactsCLIInput[];
} {
  const calls: ArtifactsCLIInput[] = [];
  return {
    calls,
    host: {
      artifacts: {
        cli: vi.fn(async (input) => {
          calls.push(input);
          return await impl(input);
        }),
      },
    },
  };
}

function makeContext(
  overrides: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
) {
  const env = new Map<string, string>(Object.entries(overrides.env ?? {}));
  return {
    fs: {} as never,
    cwd: overrides.cwd ?? "/workspace",
    env,
    stdin: encodeUTF8ToBytes(overrides.stdin ?? ""),
  };
}

describe("defineArtifactsCommand", () => {
  it("registers under the name 'artifacts'", () => {
    const { host } = fakeHost(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cmd = defineArtifactsCommand(host);
    expect(cmd.name).toBe("artifacts");
  });

  it("forwards argv verbatim (no reparsing, no shell splitting)", async () => {
    const { host, calls } = fakeHost(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cmd = defineArtifactsCommand(host);
    await cmd.execute(["repo", "create", "starter", "--description", "hi"], makeContext());
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual(["repo", "create", "starter", "--description", "hi"]);
  });

  it("flattens the env Map into a plain object", async () => {
    const { host, calls } = fakeHost(() => ({ stdout: "", stderr: "", exitCode: 0 }));
    const cmd = defineArtifactsCommand(host);
    await cmd.execute(
      ["repo", "list"],
      makeContext({ env: { CF_ACCOUNT: "abc", PATH: "/usr/bin" } }),
    );
    expect(calls[0].env).toEqual({ CF_ACCOUNT: "abc", PATH: "/usr/bin" });
  });

  it("returns the CLI result's stdout / stderr / exitCode verbatim", async () => {
    const { host } = fakeHost(() => ({ stdout: "ok\n", stderr: "warn\n", exitCode: 7 }));
    const cmd = defineArtifactsCommand(host);
    const res = await cmd.execute(["repo", "list"], makeContext());
    expect(res).toMatchObject({ stdout: "ok\n", stderr: "warn\n", exitCode: 7 });
  });

  it("surfaces a host RPC throw as exit 1 with the message on stderr", async () => {
    const { host } = fakeHost(() => {
      throw new Error("workspace stub disposed");
    });
    const cmd = defineArtifactsCommand(host);
    const res = await cmd.execute(["repo", "list"], makeContext());
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("workspace stub disposed");
    expect(res.stdout).toBe("");
  });
});
