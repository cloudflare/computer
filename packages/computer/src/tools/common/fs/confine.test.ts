import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { Workspace } from "../../../workspace.js";
import { createPiTools } from "../../pi-ai/index.js";
import { normalizeRootedPath } from "./confine.js";

async function setup() {
  const workspace = new Workspace({ storage: new SQLiteTestStorage(), now: () => 0 });
  await workspace.fs.mkdir("/workspace/src", { recursive: true });
  await workspace.fs.mkdir("/secret", { recursive: true });
  await workspace.fs.writeFile("/workspace/src/a.txt", new TextEncoder().encode("inside\n"));
  await workspace.fs.writeFile("/secret/key.txt", new TextEncoder().encode("outside\n"));
  const tools = createPiTools({ workspace, root: "/workspace" });
  const call = (name: string, args: Record<string, unknown>) =>
    tools.execute({ id: crypto.randomUUID(), name, arguments: args });
  const text = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.map((part) => part.text ?? "").join("");
  return { workspace, call, text };
}

describe("normalizeRootedPath", () => {
  it.each([
    ["/workspace", "src/a.txt", "/workspace/src/a.txt"],
    ["/workspace", "./src/../src/a.txt", "/workspace/src/a.txt"],
    ["/workspace/", "/workspace", "/workspace"],
    ["/", "/anything", "/anything"],
  ])("resolves %s + %s to %s", (root, input, expected) => {
    expect(normalizeRootedPath(root, input)).toBe(expected);
  });

  it.each([
    ["/workspace", "/secret/key.txt"],
    ["/workspace", "../secret/key.txt"],
    ["/workspace", "/workspace-other/x"],
  ])("rejects %s + %s", (root, input) => {
    expect(() => normalizeRootedPath(root, input)).toThrow(/outside \/workspace/);
  });
});

describe("tools with a root", () => {
  it("reads a path relative to the root", async () => {
    const { call, text } = await setup();

    const result = await call("read", { path: "src/a.txt" });

    expect(result.isError).toBe(false);
    expect(text(result)).toBe("inside");
  });

  it("refuses paths outside the root in every file tool", async () => {
    const { workspace, call, text } = await setup();

    for (const [name, args] of [
      ["read", { path: "/secret/key.txt" }],
      ["read", { path: "../secret/key.txt" }],
      ["ls", { path: "/secret" }],
      ["find", { path: "/secret", pattern: "**" }],
      ["grep", { path: "/secret", query: "outside" }],
      ["write", { path: "/secret/new.txt", content: "x" }],
      ["edit", { path: "/secret/key.txt", edits: [{ oldText: "outside", newText: "x" }] }],
      ["delete", { path: "/secret/key.txt" }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, name).toBe(true);
      expect(text(result), name).toContain("outside /workspace");
    }
    const key = await new Response(await workspace.fs.readFile("/secret/key.txt")).text();
    expect(key).toBe("outside\n");
    await expect(workspace.fs.stat("/secret/new.txt")).rejects.toThrow();
  });

  it("refuses a path through a symbolic link", async () => {
    const { workspace, call, text } = await setup();
    await workspace.fs.symlink("/secret", "/workspace/link");

    const read = await call("read", { path: "/workspace/link/key.txt" });
    const write = await call("write", { path: "link/new.txt", content: "x" });

    expect(read.isError).toBe(true);
    expect(text(read)).toContain("symbolic link: /workspace/link");
    expect(write.isError).toBe(true);
    await expect(workspace.fs.stat("/secret/new.txt")).rejects.toThrow();
  });

  it("writes a new file under a directory that does not exist yet", async () => {
    const { workspace, call } = await setup();

    const result = await call("write", { path: "new/dir/b.txt", content: "made" });

    expect(result.isError).toBe(false);
    const made = await new Response(await workspace.fs.readFile("/workspace/new/dir/b.txt")).text();
    expect(made).toBe("made");
  });
});
