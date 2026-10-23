import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { createGitClient } from "./git/index.js";
import { namespacePrefix } from "./namespace.js";
import { Workspace } from "./workspace.js";

function exists(ws: Workspace, path: string): Promise<boolean> {
  return ws.fs.stat(path).then(
    () => true,
    () => false,
  );
}

function tables(storage: SQLiteTestStorage): string[] {
  return storage.sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .toArray()
    .map((row) => String((row as { name: unknown }).name));
}

describe("Workspace namespaces", () => {
  it("keeps files apart between namespaces on one storage", async () => {
    const storage = new SQLiteTestStorage();
    const main = new Workspace({ storage });
    const scratch = new Workspace({ storage, namespace: "scratch" });
    const project = new Workspace({ storage, namespace: "project" });

    await main.fs.writeFile("/notes.md", "main");
    await scratch.fs.writeFile("/notes.md", "scratch");
    await project.fs.writeFile("/notes.md", "project");
    await scratch.fs.writeFile("/only-scratch.txt", "x");

    expect(await main.fs.readFile("/notes.md", "utf8")).toBe("main");
    expect(await scratch.fs.readFile("/notes.md", "utf8")).toBe("scratch");
    expect(await project.fs.readFile("/notes.md", "utf8")).toBe("project");
    expect(await exists(main, "/only-scratch.txt")).toBe(false);
    expect(await exists(project, "/only-scratch.txt")).toBe(false);

    await scratch.fs.rm("/notes.md");
    expect(await main.fs.readFile("/notes.md", "utf8")).toBe("main");
    expect(await project.fs.readFile("/notes.md", "utf8")).toBe("project");
  });

  it("finds the same files again when reopened with the same namespace", async () => {
    const storage = new SQLiteTestStorage();
    const first = new Workspace({ storage, namespace: "scratch" });
    await first.fs.mkdir("/a");
    await first.fs.writeFile("/a/b.txt", "kept");

    const reopened = new Workspace({ storage, namespace: "scratch" });

    expect(await reopened.fs.readFile("/a/b.txt", "utf8")).toBe("kept");
    expect(await exists(new Workspace({ storage }), "/a/b.txt")).toBe(false);
  });

  it("leaves the default tables where existing data already is", async () => {
    const storage = new SQLiteTestStorage();
    await new Workspace({ storage }).fs.writeFile("/old.txt", "before namespaces");
    new Workspace({ storage, namespace: "scratch" });

    const names = tables(storage);

    expect(names).toContain("vfs_nodes");
    expect(names).toContain("_vfs_mounts");
    expect(names).toContain("ws_scratch_vfs_nodes");
    expect(names).toContain("ws_scratch__vfs_mounts");
    expect(names).toContain("ws_scratch_computer_execution_runtime");
    expect(await new Workspace({ storage }).fs.readFile("/old.txt", "utf8")).toBe(
      "before namespaces",
    );
  });

  it("creates every table and index under the namespace", async () => {
    const storage = new SQLiteTestStorage();
    const scratch = new Workspace({ storage, namespace: "scratch" });
    await scratch.fs.writeFile("/a.txt", "a");

    const names = storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
      )
      .toArray()
      .map((row) => String((row as { name: unknown }).name));

    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !name.startsWith("ws_scratch_"))).toEqual([]);
  });

  it("never rewrites file names or contents", async () => {
    const storage = new SQLiteTestStorage();
    const scratch = new Workspace({ storage, namespace: "scratch" });
    const text = "SELECT * FROM vfs_nodes; DROP TABLE _vfs_mounts;";

    await scratch.fs.writeFile("/vfs_nodes.sql", text);

    expect(await scratch.fs.readFile("/vfs_nodes.sql", "utf8")).toBe(text);
    expect((await scratch.fs.readdir("/")).map((entry) => entry.name)).toContain("vfs_nodes.sql");
  });

  it("gives each namespace its own git repository", async () => {
    const storage = new SQLiteTestStorage();
    const identity = { name: "T", email: "t@example.test" };
    const scratch = new Workspace({ storage, namespace: "scratch", git: createGitClient() });
    const project = new Workspace({ storage, namespace: "project", git: createGitClient() });

    await scratch.git.init({ dir: "/repo" });
    await scratch.fs.writeFile("/repo/a.txt", "a\n");
    await scratch.git.add({ dir: "/repo", paths: ["a.txt"] });
    await scratch.git.commit({ dir: "/repo", message: "a", author: identity });

    expect(await scratch.git.log({ dir: "/repo" })).toHaveLength(1);
    expect((await project.git.cli({ argv: ["status"], cwd: "/repo" })).exitCode).not.toBe(0);
  });

  it("rejects namespaces that could clash", () => {
    const storage = new SQLiteTestStorage();
    for (const namespace of ["", "Scratch", "a_b", "a-b", "x".repeat(33)]) {
      expect(() => new Workspace({ storage, namespace })).toThrow(
        "namespace must be 1 to 32 lowercase letters and digits",
      );
    }
    expect(namespacePrefix("scratch2")).toBe("ws_scratch2_");
  });
});
