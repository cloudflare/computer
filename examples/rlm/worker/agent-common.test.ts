import type { Workspace } from "@cloudflare/computer";
import { describe, expect, it, vi } from "vitest";
import { seedWorkspace } from "./agent-common";
import type { OolongRealFixture } from "./benchmark";

describe("seedWorkspace", () => {
  it("clears stale fixture files before writing a new sample", async () => {
    const calls: string[] = [];
    const workspace = {
      ready: vi.fn<() => Promise<number>>(async () => calls.push("ready")),
      fs: {
        rm: vi.fn<() => Promise<number>>(async () => calls.push("rm")),
        mkdir: vi.fn<() => Promise<number>>(async () => calls.push("mkdir")),
        writeFile: vi.fn<(path: string) => Promise<number>>(async (path: string) =>
          calls.push(`write:${path}`),
        ),
      },
    } as unknown as Workspace;
    const fixture = {
      context: "new context",
      chunks: ["new chunk"],
      manifest: {
        contextChunks: [{ path: "/workspace/oolong-real/context-0000.txt" }],
      },
    } as unknown as OolongRealFixture;

    await seedWorkspace(workspace, fixture);

    expect(workspace.fs.rm).toHaveBeenCalledWith("/workspace/oolong-real", {
      recursive: true,
      force: true,
    });
    expect(calls.slice(0, 3)).toEqual(["ready", "rm", "mkdir"]);
  });
});
