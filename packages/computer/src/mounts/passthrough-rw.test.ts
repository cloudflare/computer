import {
  applyChanges,
  applyChangesSync,
  type ChangeEntry,
  createWorkspaceError,
} from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { WorkspaceFsAdapter } from "../backends/worker-shell/adapter";
import { createGitClient } from "../git/index";
import { Workspace } from "../workspace";
import type { PassthroughDirent, PassthroughMount, PassthroughStat } from "./types";

const ROOT = "/skills/team";

type Method = "writeFile" | "mkdir" | "rm" | "rename" | "chmod";

interface Call {
  method: string;
  path: string;
  to?: string;
  options?: Record<string, unknown>;
}

type FakeMount = PassthroughMount & {
  calls: Call[];
  files: Map<string, { bytes: Uint8Array; mode: number }>;
  dirs: Map<string, number>;
};

const encoder = new TextEncoder();

function fail(code: Parameters<typeof createWorkspaceError>[0], path: string): Error {
  return createWorkspaceError(code, code.toLowerCase(), path);
}

// An in-memory read-write passthrough mount. `without` leaves methods
// out; `failOn` makes writeFile throw for a path.
function writableMount(
  initial: Record<string, string> = {},
  options: { without?: Method[]; failOn?: (path: string) => Error | undefined } = {},
): FakeMount {
  const files = new Map<string, { bytes: Uint8Array; mode: number }>();
  const dirs = new Map<string, number>([["", 0o755]]);
  const parentOf = (path: string) =>
    path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  for (const [path, text] of Object.entries(initial)) {
    files.set(path, { bytes: encoder.encode(text), mode: 0o644 });
    for (let p = parentOf(path); p !== ""; p = parentOf(p)) dirs.set(p, 0o755);
  }
  const statOf = (path: string): PassthroughStat | null => {
    const file = files.get(path);
    if (file) return { type: "file", size: file.bytes.byteLength, mtime: 1, mode: file.mode };
    const dir = dirs.get(path);
    return dir === undefined ? null : { type: "dir", size: 0, mtime: 1, mode: dir };
  };
  const children = (path: string) =>
    [...dirs.keys(), ...files.keys()].filter((p) => p !== "" && p !== path && parentOf(p) === path);
  const below = (path: string) =>
    [...dirs.keys(), ...files.keys()].filter(
      (p) => p !== "" && (path === "" || p.startsWith(`${path}/`)),
    );
  const calls: Call[] = [];
  const record = (method: string, path: string, opts?: Record<string, unknown>, to?: string) =>
    calls.push({
      method,
      path,
      ...(to === undefined ? {} : { to }),
      ...(opts ? { options: opts } : {}),
    });

  const mount: FakeMount = {
    kind: "fake-rw",
    strategy: "passthrough",
    mode: "read-write",
    calls,
    files,
    dirs,
    async stat(path) {
      return statOf(path);
    },
    async readdir(path, opts) {
      if (files.has(path)) throw fail("ENOTDIR", path);
      if (!dirs.has(path)) return null;
      const names = opts?.recursive ? below(path) : children(path);
      const prefix = path === "" ? "" : `${path}/`;
      return names
        .sort((a, b) => a.split("/").length - b.split("/").length)
        .map((p): PassthroughDirent => ({
          name: p.slice(prefix.length),
          ...(statOf(p) as PassthroughStat),
        }));
    },
    async readFile(path) {
      const file = files.get(path);
      if (!file) return dirs.has(path) ? null : null;
      return {
        stat: statOf(path) as PassthroughStat,
        offset: 0,
        body: new Response(file.bytes).body as ReadableStream<Uint8Array>,
      };
    },
    async writeFile(path, body, opts) {
      record("writeFile", path, opts as Record<string, unknown>);
      const failure = options.failOn?.(path);
      if (failure !== undefined) throw failure;
      if (dirs.has(path)) throw fail("EISDIR", path);
      if (opts.exclusive && files.has(path)) throw fail("EEXIST", path);
      if (!dirs.has(parentOf(path))) throw fail("ENOENT", path);
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      files.set(path, { bytes, mode: opts.mode ?? 0o644 });
      return statOf(path) as PassthroughStat;
    },
    async mkdir(path, opts) {
      record("mkdir", path, opts as Record<string, unknown>);
      if (files.has(path)) throw fail("EEXIST", path);
      if (dirs.has(path)) {
        if (opts.recursive) return;
        throw fail("EEXIST", path);
      }
      if (!dirs.has(parentOf(path))) {
        if (!opts.recursive) throw fail("ENOENT", path);
        for (let p = parentOf(path); p !== "" && !dirs.has(p); p = parentOf(p)) dirs.set(p, 0o755);
      }
      dirs.set(path, opts.mode ?? 0o755);
    },
    async rm(path, opts) {
      record("rm", path, opts as Record<string, unknown>);
      if (files.delete(path)) return;
      if (!dirs.has(path)) throw fail("ENOENT", path);
      const inside = below(path);
      if (inside.length > 0 && !opts.recursive) throw fail("ENOTEMPTY", path);
      for (const p of inside) {
        files.delete(p);
        dirs.delete(p);
      }
      dirs.delete(path);
    },
    async rename(from, to, opts) {
      record("rename", from, opts as Record<string, unknown>, to);
      const file = files.get(from);
      if (file) {
        files.delete(from);
        files.set(to, file);
        return;
      }
      if (!dirs.has(from)) throw fail("ENOENT", from);
      for (const p of below(from)) {
        const moved = `${to}${p.slice(from.length)}`;
        const f = files.get(p);
        if (f) {
          files.delete(p);
          files.set(moved, f);
        } else {
          dirs.set(moved, dirs.get(p) as number);
          dirs.delete(p);
        }
      }
      dirs.set(to, dirs.get(from) as number);
      dirs.delete(from);
    },
    async chmod(path, mode, opts) {
      record("chmod", path, opts as Record<string, unknown>);
      const file = files.get(path);
      if (file) file.mode = mode;
      else if (dirs.has(path)) dirs.set(path, mode);
      else throw fail("ENOENT", path);
    },
  };
  for (const method of options.without ?? []) delete (mount as Partial<FakeMount>)[method];
  return mount;
}

function open(mounts: Record<string, PassthroughMount>, storage = new SQLiteTestStorage()) {
  return new Workspace({ storage, mounts });
}

function storedNames(ws: Workspace): string[] {
  return ws.db.all<{ name: string }>("SELECT name FROM vfs_dirents").map((row) => row.name);
}

function text(mount: FakeMount, path: string): string | undefined {
  const file = mount.files.get(path);
  return file && new TextDecoder().decode(file.bytes);
}

function stream(value: string): ReadableStream<Uint8Array> {
  return new Response(value).body as ReadableStream<Uint8Array>;
}

describe("read-write passthrough mounts", () => {
  it("sends every write under the root to the mount and stores nothing", async () => {
    const mount = writableMount({ "keep.md": "kept\n" });
    const ws = open({ [ROOT]: mount });

    await ws.fs.writeFile(`${ROOT}/a.md`, "string\n");
    await ws.fs.writeFile(`${ROOT}/b.bin`, new Uint8Array([1, 2, 3]), { mode: 0o755 });
    await ws.fs.mkdir(`${ROOT}/dir`);
    await ws.fs.mkdir(`${ROOT}/deep/er/still`, { recursive: true });
    await ws.fs.writeFile(`${ROOT}/dir/c.md`, stream("streamed\n"));
    await ws.fs.rename(`${ROOT}/a.md`, `${ROOT}/dir/a.md`);
    await ws.fs.chmod(`${ROOT}/dir/a.md`, 0o600);
    await ws.fs.rm(`${ROOT}/keep.md`);
    await ws.fs.rm(`${ROOT}/deep`, { recursive: true });
    await ws.fs.rm(`${ROOT}/nope.md`, { force: true });

    expect(mount.calls.map((call) => [call.method, call.path, call.to].filter(Boolean))).toEqual([
      ["writeFile", "a.md"],
      ["writeFile", "b.bin"],
      ["mkdir", "dir"],
      ["mkdir", "deep/er/still"],
      ["writeFile", "dir/c.md"],
      ["rename", "a.md", "dir/a.md"],
      ["chmod", "dir/a.md"],
      ["rm", "keep.md"],
      ["rm", "deep"],
      ["rm", "nope.md"],
    ]);
    for (const call of mount.calls) {
      expect(call.options?.signal, call.method).toBeInstanceOf(AbortSignal);
    }
    expect(mount.calls[0].options).toMatchObject({ size: 7 });
    expect(mount.calls[1].options).toMatchObject({ size: 3, mode: 0o755 });
    expect(mount.calls[3].options).toMatchObject({ recursive: true });

    expect(await ws.fs.readFile(`${ROOT}/dir/a.md`, "utf8")).toBe("string\n");
    expect(await ws.fs.readFile(`${ROOT}/dir/c.md`, "utf8")).toBe("streamed\n");
    expect((await ws.fs.stat(`${ROOT}/dir/a.md`)).mode).toBe(0o600);
    expect((await ws.fs.find(ROOT)).map((entry) => entry.path)).toEqual([
      `${ROOT}/b.bin`,
      `${ROOT}/dir`,
      `${ROOT}/dir/a.md`,
      `${ROOT}/dir/c.md`,
    ]);
    const names = storedNames(ws);
    for (const name of ["team", "a.md", "b.bin", "dir", "c.md", "deep"]) {
      expect(names, name).not.toContain(name);
    }
  });

  it("passes the mount's errors through, and an exclusive write's EEXIST", async () => {
    const mount = writableMount(
      { "a.md": "a" },
      {
        failOn: (path) =>
          path === "full.md"
            ? createWorkspaceError("ENOSPC", `out of space ${"x".repeat(5_000)}`, "full.md")
            : path === "boom.md"
              ? new Error("upstream exploded")
              : undefined,
      },
    );
    const ws = open({ [ROOT]: mount });
    await expect(ws.fs.writeFile(`${ROOT}/a.md`, "b", { exclusive: true })).rejects.toMatchObject({
      code: "EEXIST",
      path: `${ROOT}/a.md`,
    });
    expect(mount.calls[0].options).toMatchObject({ exclusive: true });
    expect(text(mount, "a.md")).toBe("a");
    const full = await ws.fs.writeFile(`${ROOT}/full.md`, "x").catch((error: unknown) => error);
    expect(full).toMatchObject({ code: "ENOSPC", path: `${ROOT}/full.md` });
    expect((full as Error).message.length).toBeLessThan(1_200);
    await expect(ws.fs.writeFile(`${ROOT}/boom.md`, "x")).rejects.toMatchObject({ code: "EIO" });
    await expect(ws.fs.mkdir(`${ROOT}/a.md`)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(ws.fs.rm(`${ROOT}/missing`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(ws.fs.writeFile(`${ROOT}/no/parent.md`, "x")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails a write the mount has no method for with EROFS", async () => {
    const mount = writableMount({ "a.md": "a" }, { without: ["mkdir", "rm", "rename", "chmod"] });
    const ws = open({ [ROOT]: mount });
    await ws.fs.writeFile(`${ROOT}/b.md`, "b");
    for (const [name, attempt] of [
      ["mkdir", () => ws.fs.mkdir(`${ROOT}/d`)],
      ["rm", () => ws.fs.rm(`${ROOT}/a.md`)],
      ["rename", () => ws.fs.rename(`${ROOT}/a.md`, `${ROOT}/c.md`)],
      ["chmod", () => ws.fs.chmod(`${ROOT}/a.md`, 0o600)],
    ] as const) {
      await expect(attempt(), name).rejects.toMatchObject({ code: "EROFS" });
    }
    expect(mount.calls.map((call) => call.method)).toEqual(["writeFile"]);
  });

  it("refuses links, partial and synchronous writes with ENOTSUP", async () => {
    const mount = writableMount({ "a.md": "a" });
    const ws = open({ [ROOT]: mount });
    const provider = ws.provider();
    await ws.fs.writeFile("/x", "x");
    const path = `${ROOT}/a.md`;
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["symlink", () => ws.fs.symlink("/x", `${ROOT}/l`)],
      ["provider symlink", () => provider.symlink("/x", `${ROOT}/l`)],
      ["provider link", () => provider.link("/x", `${ROOT}/h`)],
      ["provider link from", () => provider.link(path, "/h")],
      ["writeFileSync", async () => provider.writeFileSync(path, "y")],
      ["mkdirSync", async () => provider.mkdirSync(`${ROOT}/d`)],
      ["unlinkSync", async () => provider.unlinkSync(path)],
      ["rmdirSync", async () => provider.rmdirSync(`${ROOT}`)],
      ["renameSync", async () => provider.renameSync(path, `${ROOT}/b.md`)],
      ["chmodSync", async () => provider.chmodSync(path, 0o600)],
      ["symlinkSync", async () => provider.symlinkSync("/x", `${ROOT}/l`)],
      ["openSync w", async () => provider.openSync(path, "w")],
      ["openSync a", async () => provider.openSync(path, "a")],
      ["open w", async () => provider.open(path, "w")],
      ["writeRangeSync", async () => provider.writeRangeSync(path, "z", 1)],
      ["truncateSync", async () => provider.truncateSync(path, 0)],
      ["createFileSync", async () => provider.createFileSync(`${ROOT}/new.md`)],
    ];
    for (const [name, attempt] of attempts) {
      await expect(attempt(), name).rejects.toMatchObject({ code: "ENOTSUP" });
    }
    expect(mount.calls).toEqual([]);
    expect(text(mount, "a.md")).toBe("a");
  });

  it("fails renames across the mount's boundary with EXDEV and of its root with EBUSY", async () => {
    const mount = writableMount({ "a.md": "a" });
    const other = writableMount({ "o.md": "o" });
    const ws = open({ [ROOT]: mount, "/other": other });
    await ws.fs.writeFile("/store.md", "s");

    const exdev: Array<[string, string]> = [
      ["/store.md", `${ROOT}/store.md`],
      [`${ROOT}/a.md`, "/a.md"],
      [`${ROOT}/a.md`, "/other/a.md"],
    ];
    for (const [from, to] of exdev) {
      await expect(ws.fs.rename(from, to), `${from} -> ${to}`).rejects.toMatchObject({
        code: "EXDEV",
      });
    }
    await expect(ws.fs.rm(ROOT, { recursive: true })).rejects.toMatchObject({ code: "EBUSY" });
    await expect(ws.fs.rename(ROOT, "/elsewhere")).rejects.toMatchObject({ code: "EBUSY" });
    await expect(ws.fs.rename(`${ROOT}/a.md`, ROOT)).rejects.toMatchObject({ code: "EBUSY" });
    await expect(ws.provider().rmdir(ROOT)).rejects.toMatchObject({ code: "EBUSY" });
    // Above the root, the guard of a read-only mount.
    await expect(ws.fs.rm("/skills", { recursive: true })).rejects.toMatchObject({ code: "EROFS" });
    await expect(ws.fs.rename("/skills", "/moved")).rejects.toMatchObject({ code: "EROFS" });
    expect(mount.calls).toEqual([]);
    expect(other.calls).toEqual([]);
    expect(await ws.fs.readFile("/store.md", "utf8")).toBe("s");
  });

  it("routes writes through links into the root", async () => {
    const mount = writableMount({ "a.md": "a" });
    const ws = open({ [ROOT]: mount });
    await ws.fs.symlink(ROOT, "/link");
    await ws.fs.symlink("/skills", "/up");
    await ws.fs.symlink(`${ROOT}/a.md`, "/filelink");

    await ws.fs.writeFile("/link/b.md", "b");
    await ws.fs.writeFile("/up/team/c.md", "c");
    await ws.fs.writeFile("/filelink", "a2");
    await ws.fs.mkdir("/link/d");
    await ws.fs.rename("/link/b.md", "/up/team/d/b.md");
    await ws.fs.chmod("/filelink", 0o600);
    await ws.fs.rm("/up/team/c.md");
    expect(mount.calls.map((call) => [call.method, call.path, call.to].filter(Boolean))).toEqual([
      ["writeFile", "b.md"],
      ["writeFile", "c.md"],
      ["writeFile", "a.md"],
      ["mkdir", "d"],
      ["rename", "b.md", "d/b.md"],
      ["chmod", "a.md"],
      ["rm", "c.md"],
    ]);
    expect(text(mount, "a.md")).toBe("a2");
    expect(text(mount, "d/b.md")).toBe("b");
    // The links stay the store's.
    await ws.fs.rm("/filelink");
    expect(mount.files.has("a.md")).toBe(true);
    const names = storedNames(ws);
    for (const name of ["team", "b.md", "c.md", "d"]) expect(names, name).not.toContain(name);
  });

  it("serves the provider's async writes and the worker shell's", async () => {
    const mount = writableMount({ "a.md": "a" });
    const ws = open({ [ROOT]: mount });
    const provider = ws.provider();
    await provider.writeFile(`${ROOT}/p.md`, "p");
    await provider.mkdir(`${ROOT}/pd`);
    await provider.rename(`${ROOT}/p.md`, `${ROOT}/pd/p.md`);
    await provider.unlink(`${ROOT}/pd/p.md`);
    await provider.rmdir(`${ROOT}/pd`);
    await expect(provider.rmdir(`${ROOT}/a.md`)).rejects.toMatchObject({ code: "ENOTDIR" });
    await provider.mkdir(`${ROOT}/q`);
    await expect(provider.unlink(`${ROOT}/q`)).rejects.toMatchObject({ code: "EISDIR" });

    const shell = new WorkspaceFsAdapter(ws.stub().fs);
    await shell.writeFile(`${ROOT}/s.md`, "shell");
    await shell.mkdir(`${ROOT}/sd`);
    await shell.mv(`${ROOT}/s.md`, `${ROOT}/sd/s.md`);
    expect(await shell.readFile(`${ROOT}/sd/s.md`)).toBe("shell");
    await shell.rm(`${ROOT}/sd`, { recursive: true });
    expect([...mount.files.keys()].sort()).toEqual(["a.md"]);
  });

  it("writes container changes through, entry by entry", async () => {
    const mount = writableMount(
      { "old.md": "old", "gone/x.md": "x" },
      { failOn: (path) => (path === "bad.md" ? fail("EACCES", path) : undefined) },
    );
    const ws = open({ [ROOT]: mount });
    await ws.fs.symlink(ROOT, "/link");
    const bytes = encoder.encode("from container\n");
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
    const file = (path: string): ChangeEntry => ({
      kind: "file",
      rev: 100,
      path,
      mode: 0o644,
      mtime: 1,
      size: bytes.byteLength,
      chunks: [{ hash, size: bytes.byteLength }],
    });
    const result = await applyChanges(
      ws.db,
      [
        { kind: "dir", rev: 99, path: `${ROOT}/new`, mode: 0o755, mtime: 1 },
        file(`${ROOT}/new/a.md`),
        file(`${ROOT}/bad.md`),
        file("/link/via-link.md"),
        { kind: "symlink", rev: 101, path: `${ROOT}/l`, target: "/x", mode: 0o777, mtime: 1 },
        { kind: "delete", rev: 102, path: `${ROOT}/old.md` },
        { kind: "delete", rev: 103, path: `${ROOT}/gone` },
        { kind: "delete", rev: 104, path: ROOT },
        { kind: "delete", rev: 105, path: "/skills" },
        file("/skills/beside.md"),
      ],
      new Map([[hex, bytes]]),
    );

    expect(result.applied).toBe(6);
    expect(result.skipped).toEqual([
      expect.objectContaining({ path: `${ROOT}/bad.md`, mountRoot: ROOT, reason: "mount-error" }),
      expect.objectContaining({ path: `${ROOT}/l`, mountRoot: ROOT, reason: "mount-error" }),
      expect.objectContaining({ path: ROOT, op: "delete", reason: "mount-error" }),
      expect.objectContaining({ path: "/skills", op: "delete", reason: "read-only" }),
    ]);
    expect(result.skipped[0].error).toMatch(/^EACCES/);
    expect(result.skipped[1].error).toMatch(/^ENOTSUP/);
    expect(result.skipped[2].error).toMatch(/^EBUSY/);
    expect(text(mount, "new/a.md")).toBe("from container\n");
    expect(text(mount, "via-link.md")).toBe("from container\n");
    expect(mount.files.has("old.md")).toBe(false);
    expect(mount.dirs.has("gone")).toBe(false);
    expect(await ws.fs.readFile("/skills/beside.md", "utf8")).toBe("from container\n");
    const names = storedNames(ws);
    for (const name of ["new", "a.md", "via-link.md", "team"])
      expect(names, name).not.toContain(name);

    // A synchronous apply can't wait for the mount: it reports the entry.
    const sync = applyChangesSync(ws.db, [file(`${ROOT}/sync.md`)], new Map([[hex, bytes]]));
    expect(sync.skipped).toEqual([
      expect.objectContaining({ path: `${ROOT}/sync.md`, reason: "mount-error" }),
    ]);
    expect(mount.files.has("sync.md")).toBe(false);
  });

  it("lets git write a repository into the root", async () => {
    const mount = writableMount();
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      mounts: { "/repo": mount },
      git: createGitClient(),
      defaultGitIdentity: { name: "Test", email: "test@example.com" },
    });
    await ws.git.init({ dir: "/repo" });
    await ws.fs.writeFile("/repo/a.md", "one\n");
    await ws.git.add({ dir: "/repo", paths: ["a.md"] });
    const first = await ws.git.commit({ dir: "/repo", message: "one" });
    await ws.git.branch({ dir: "/repo", name: "two", checkout: true });
    await ws.fs.writeFile("/repo/b.md", "two\n");
    await ws.fs.writeFile("/repo/a.md", "one, changed\n");
    await ws.git.add({ dir: "/repo", paths: ["a.md", "b.md"] });
    await ws.git.commit({ dir: "/repo", message: "two" });

    await ws.git.checkout({ dir: "/repo", ref: "main" });
    expect(await ws.fs.readFile("/repo/a.md", "utf8")).toBe("one\n");
    await expect(ws.fs.stat("/repo/b.md")).rejects.toMatchObject({ code: "ENOENT" });
    await ws.git.checkout({ dir: "/repo", ref: "two" });
    expect(await ws.fs.readFile("/repo/b.md", "utf8")).toBe("two\n");
    expect((await ws.git.log({ dir: "/repo" })).map((commit) => commit.message.trim())).toEqual([
      "two",
      "one",
    ]);
    expect(first).toBeDefined();
    expect([...mount.files.keys()].some((path) => path.startsWith(".git/objects/"))).toBe(true);
    const names = storedNames(ws);
    for (const name of [".git", "a.md", "b.md", "objects"]) expect(names, name).not.toContain(name);
  });

  it("leaves read-only passthrough mounts read-only", async () => {
    const writable = writableMount();
    const readOnly = { ...writableMount({ "r.md": "r" }), mode: "read-only" as const };
    const ws = open({ [ROOT]: writable, "/ro": readOnly });
    for (const [name, attempt] of [
      ["writeFile", () => ws.fs.writeFile("/ro/x.md", "x")],
      ["mkdir", () => ws.fs.mkdir("/ro/d")],
      ["rm", () => ws.fs.rm("/ro/r.md")],
      ["rename", () => ws.fs.rename("/ro/r.md", "/ro/s.md")],
      ["rename out", () => ws.fs.rename("/ro/r.md", `${ROOT}/r.md`)],
      ["chmod", () => ws.fs.chmod("/ro/r.md", 0o600)],
      ["provider writeFile", () => ws.provider().writeFile("/ro/x.md", "x")],
      ["provider writeFileSync", async () => ws.provider().writeFileSync("/ro/x.md", "x")],
    ] as const) {
      await expect(attempt(), name).rejects.toMatchObject({ code: "EROFS" });
    }
    expect(readOnly.calls).toEqual([]);
  });
});
