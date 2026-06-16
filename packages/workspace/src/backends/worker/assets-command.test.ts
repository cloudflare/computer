import { describe, expect, it } from "vitest";

import { defineAssetsCommand } from "./assets-command.js";

function ctx(cwd = "/workspace") {
  return { fs: {} as never, cwd, env: new Map<string, string>(), stdin: "" };
}

describe("defineAssetsCommand", () => {
  it("publishes an absolute path and writes the URL to stdout", async () => {
    const calls: Array<{ path: string; expiresAfter: number }> = [];
    const command = defineAssetsCommand({
      assets: {
        publish: async (path, options) => {
          calls.push({ path, expiresAfter: options.expiresAfter });
          return "https://example.com/shared.png";
        },
      },
    });

    const result = await command.execute(["publish", "/workspace/out/image.png"], ctx());

    expect(result).toEqual({ stdout: "https://example.com/shared.png\n", stderr: "", exitCode: 0 });
    expect(calls).toEqual([{ path: "/workspace/out/image.png", expiresAfter: 60 * 60 * 1000 }]);
  });

  it("resolves a relative path against cwd", async () => {
    const calls: string[] = [];
    const command = defineAssetsCommand({
      assets: {
        publish: async (path) => {
          calls.push(path);
          return "https://example.com/shared.png";
        },
      },
    });

    await command.execute(["publish", "images/../out/image.png"], ctx("/workspace/project"));

    expect(calls).toEqual(["/workspace/project/out/image.png"]);
  });

  it("uses a numeric expiry as milliseconds", async () => {
    const calls: number[] = [];
    const command = defineAssetsCommand({
      assets: {
        publish: async (_path, options) => {
          calls.push(options.expiresAfter);
          return "https://example.com/shared.png";
        },
      },
    });

    await command.execute(["publish", "/workspace/out/image.png", "30000"], ctx());

    expect(calls).toEqual([30_000]);
  });

  it("supports s, m, and h expiry suffixes", async () => {
    const calls: number[] = [];
    const command = defineAssetsCommand({
      assets: {
        publish: async (_path, options) => {
          calls.push(options.expiresAfter);
          return "https://example.com/shared.png";
        },
      },
    });

    await command.execute(["publish", "/workspace/a.png", "30s"], ctx());
    await command.execute(["publish", "/workspace/a.png", "5m"], ctx());
    await command.execute(["publish", "/workspace/a.png", "2h"], ctx());

    expect(calls).toEqual([30_000, 5 * 60_000, 2 * 60 * 60_000]);
  });

  it("prints usage for an unknown subcommand", async () => {
    const command = defineAssetsCommand({ assets: { publish: async () => "" } });

    const result = await command.execute(["nope"], ctx());

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: assets publish <path> [<expiry>]");
  });

  it("returns a command failure when publishing throws", async () => {
    const command = defineAssetsCommand({
      assets: {
        publish: async () => {
          throw new Error("missing file");
        },
      },
    });

    const result = await command.execute(["publish", "/workspace/nope.png"], ctx());

    expect(result).toEqual({ stdout: "", stderr: "assets: missing file\n", exitCode: 1 });
  });
});
