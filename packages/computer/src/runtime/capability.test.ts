import { describe, expect, it, vi } from "vitest";
import { assertRuntimeValue, WorkspaceRuntimeCapability } from "./capability.js";
import type { WorkspaceRuntimeFilesystem } from "./types.js";

function fakeFs(): WorkspaceRuntimeFilesystem {
  return {
    readFile: vi.fn() as unknown as WorkspaceRuntimeFilesystem["readFile"],
    stat: vi.fn().mockResolvedValue({ size: 0 }),
    lstat: vi.fn().mockResolvedValue({ isSymbolicLink: false }),
    readlink: vi.fn(),
    readdir: vi.fn().mockResolvedValue([]),
    find: vi.fn().mockResolvedValue([]),
    ls: vi.fn().mockResolvedValue([]),
    grep: vi.fn().mockResolvedValue([]),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    chmod: vi.fn(),
    symlink: vi.fn(),
  };
}

describe("WorkspaceRuntimeCapability", () => {
  it("resolves relative and absolute paths under its root", () => {
    const workspace = new WorkspaceRuntimeCapability(fakeFs(), "/workspace", "read");
    expect(workspace.resolve("notes/a.txt")).toBe("/workspace/notes/a.txt");
    expect(workspace.resolve("/workspace/notes/./a.txt")).toBe("/workspace/notes/a.txt");
  });

  it("rejects traversal outside its root", () => {
    const workspace = new WorkspaceRuntimeCapability(fakeFs(), "/workspace", "read");
    expect(() => workspace.resolve("../secret.txt")).toThrow("stay under /workspace");
    expect(() => workspace.resolve("/etc/passwd")).toThrow("stay under /workspace");
  });

  it("blocks every mutation for a read-only capability", async () => {
    const fs = fakeFs();
    const workspace = new WorkspaceRuntimeCapability(fs, "/workspace", "read");
    await expect(workspace.writeFile("result.txt", "nope")).rejects.toThrow(
      "write access is not available",
    );
    await expect(workspace.mkdir("directory")).rejects.toThrow("write access is not available");
    await expect(workspace.rm("result.txt")).rejects.toThrow("write access is not available");
    await expect(workspace.chmod("result.txt", 0o600)).rejects.toThrow(
      "write access is not available",
    );
    await expect(workspace.symlink("target", "link")).rejects.toThrow(
      "write access is not available",
    );
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
    expect(fs.chmod).not.toHaveBeenCalled();
    expect(fs.symlink).not.toHaveBeenCalled();
  });

  it("creates parents and writes through a read-write capability", async () => {
    const fs = fakeFs();
    const workspace = new WorkspaceRuntimeCapability(fs, "/workspace", "read-write");
    await workspace.writeFile("nested/result.txt", "ok");
    expect(fs.mkdir).toHaveBeenCalledWith("/workspace/nested", { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith("/workspace/nested/result.txt", "ok");
  });

  it("rejects files larger than the capability read ceiling before materializing them", async () => {
    const fs = fakeFs();
    vi.mocked(fs.stat).mockResolvedValue({ size: 5 } as never);
    const workspace = new WorkspaceRuntimeCapability(fs, "/workspace", "read", 4);
    await expect(workspace.readFile("large.txt")).rejects.toThrow("exceeds 4 bytes");
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("bounds directory materialization and returns dirent metadata without follow-up stats", async () => {
    const fs = fakeFs();
    vi.mocked(fs.readdir).mockResolvedValue([
      { name: "a", isFile: true, isDirectory: false, isSymbolicLink: false },
      { name: "b", isFile: false, isDirectory: true, isSymbolicLink: false },
      { name: "c", isFile: true, isDirectory: false, isSymbolicLink: false },
    ]);
    const workspace = new WorkspaceRuntimeCapability(fs, "/workspace", "read", 1024, 2);

    await expect(workspace.readdir(".")).rejects.toThrow("exceeds 2 entries");
    expect(fs.readdir).toHaveBeenCalledWith("/workspace", { limit: 3 });

    vi.mocked(fs.readdir).mockResolvedValueOnce([
      { name: "a", isFile: true, isDirectory: false, isSymbolicLink: false },
    ]);
    await expect(workspace.readdirWithFileTypes(".")).resolves.toEqual([
      { name: "a", isFile: true, isDirectory: false, isSymbolicLink: false },
    ]);
  });

  it("applies node writeFile parent and exclusive-create semantics", async () => {
    const fs = fakeFs();
    const workspace = new WorkspaceRuntimeCapability(fs, "/workspace", "read-write");
    const exists = Object.assign(new Error("exists"), { code: "EEXIST" });
    vi.mocked(fs.writeFile).mockRejectedValueOnce(exists);
    await expect(workspace.writeFileNode("existing.txt", "nope", { flag: "wx" })).rejects.toBe(
      exists,
    );
    expect(fs.writeFile).toHaveBeenCalledWith("/workspace/existing.txt", "nope", {
      exclusive: true,
    });

    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    vi.mocked(fs.lstat).mockImplementation(async (path) => {
      if (path === "/workspace/missing") throw missing;
      return { isSymbolicLink: false } as never;
    });
    await expect(workspace.writeFileNode("missing/file.txt", "nope")).rejects.toBe(missing);
  });

  it("preserves a relative symlink target after validating confinement", async () => {
    const fs = fakeFs();
    const workspace = new WorkspaceRuntimeCapability(fs, "/workspace", "read-write");
    await workspace.symlink("../target", "dir/link");
    expect(fs.symlink).toHaveBeenCalledWith("../target", "/workspace/dir/link");
  });

  it("rejects existing symlinks in the configured root and path", async () => {
    const fs = fakeFs();
    vi.mocked(fs.lstat).mockImplementation(async (path) =>
      path === "/workspace/link"
        ? ({ isSymbolicLink: true } as Awaited<ReturnType<WorkspaceRuntimeFilesystem["lstat"]>>)
        : ({ isSymbolicLink: false } as Awaited<ReturnType<WorkspaceRuntimeFilesystem["lstat"]>>),
    );
    const workspace = new WorkspaceRuntimeCapability(fs, "/workspace", "read-write");
    await expect(workspace.readFile("link/secret.txt")).rejects.toThrow(
      "cannot traverse symbolic link /workspace/link",
    );
    await expect(workspace.writeFile("link/result.txt", "nope")).rejects.toThrow(
      "cannot traverse symbolic link /workspace/link",
    );
  });
});

describe("assertRuntimeValue", () => {
  it("accepts JSON-compatible values", () => {
    expect(() => assertRuntimeValue({ ok: true, values: [1, "two", null] })).not.toThrow();
  });

  it("rejects non-finite numbers, class instances, and cycles", () => {
    expect(() => assertRuntimeValue(Number.NaN)).toThrow("JSON-compatible");
    expect(() => assertRuntimeValue(new Date())).toThrow("plain objects");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => assertRuntimeValue(cycle)).toThrow("cannot contain cycles");
  });
});
