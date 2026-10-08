import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { Workspace } from "../../../workspace.js";
import { findInWorkspace } from "./find.js";
import { grepInputSchema, grepInWorkspace } from "./grep.js";

async function makeWorkspace(): Promise<Workspace> {
  const workspace = new Workspace({ storage: new SQLiteTestStorage(), now: () => 0 });
  await workspace.fs.mkdir("/workspace/src", { recursive: true });
  await workspace.fs.mkdir("/workspace/node_modules/dep", { recursive: true });
  const write = (path: string, text: string) =>
    workspace.fs.writeFile(path, new TextEncoder().encode(text));
  await write("/workspace/src/a.ts", "needle\n");
  await write("/workspace/src/b.md", "needle\n");
  await write("/workspace/src/c.json", "needle\n");
  await write("/workspace/node_modules/dep/index.ts", "needle\n");
  return workspace;
}

function paths(result: Awaited<ReturnType<typeof grepInWorkspace>>): string[] {
  if ("error" in result) throw new Error(result.error);
  return result.matches.map((match) => match.path).sort();
}

describe("grepInWorkspace globs", () => {
  it("takes several include globs", async () => {
    const workspace = await makeWorkspace();

    const result = await grepInWorkspace(workspace, {
      query: "needle",
      include: ["src/*.ts", "src/*.md"],
    });

    expect(paths(result)).toEqual(["/workspace/src/a.ts", "/workspace/src/b.md"]);
  });

  it("takes one exclude glob as a string", async () => {
    const workspace = await makeWorkspace();

    const result = await grepInWorkspace(workspace, {
      query: "needle",
      exclude: "node_modules/**",
    });

    expect(paths(result)).toEqual([
      "/workspace/src/a.ts",
      "/workspace/src/b.md",
      "/workspace/src/c.json",
    ]);
  });

  it("ignores blank globs", async () => {
    const workspace = await makeWorkspace();

    const result = await grepInWorkspace(workspace, {
      query: "needle",
      include: [" "],
      exclude: [""],
    });

    expect(paths(result)).toHaveLength(4);
  });

  it("accepts a string or a list in its schema", () => {
    expect(
      grepInputSchema.safeParse({ query: "x", include: "*.ts", exclude: "a/**" }).success,
    ).toBe(true);
    expect(
      grepInputSchema.safeParse({ query: "x", include: ["*.ts"], exclude: ["a/**"] }).success,
    ).toBe(true);
    expect(grepInputSchema.safeParse({ query: "x", include: 1 }).success).toBe(false);
  });
});

describe("findInWorkspace globs", () => {
  it("takes one exclude glob as a string", async () => {
    const workspace = await makeWorkspace();

    const result = await findInWorkspace(workspace, {
      pattern: "**/*.ts",
      exclude: "node_modules/**",
    });

    if ("error" in result) throw new Error(result.error);
    expect(result.entries.map((entry) => entry.path)).toEqual(["/workspace/src/a.ts"]);
  });
});
