import {
  applyChanges,
  applyChangesSync,
  type ChangeEntry,
  createWorkspaceError,
  currentRev,
  materialiseChange,
  readPushCursor,
  writeFetchCursor,
  writePushCursor,
} from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceFsAdapter } from "../backends/worker-shell/adapter";
import { createGitClient } from "../git/index";
import { WorkspaceRuntimeCapability } from "../runtime/capability";
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

async function fileEntry(path: string, content: string, rev: number) {
  const bytes = encoder.encode(content);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  const entry: ChangeEntry = {
    kind: "file",
    rev,
    path,
    mode: 0o644,
    mtime: 1,
    size: bytes.byteLength,
    chunks: bytes.byteLength === 0 ? [] : [{ hash, size: bytes.byteLength }],
  };
  return { entry, objects: new Map([[hex, bytes]]) };
}

// The delete a container sends after removing `content`: its prior is
// the fingerprint of that version.
async function deleteEntry(path: string, content: string, rev: number): Promise<ChangeEntry> {
  const scratch = new Workspace({ storage: new SQLiteTestStorage() });
  await scratch.fs.writeFile("/f", content);
  await scratch.fs.rm("/f");
  const tombstone = materialiseChange(scratch.db, "/f");
  if (tombstone?.kind !== "delete" || tombstone.prior === undefined) {
    throw new Error("expected a fingerprinted tombstone");
  }
  return { kind: "delete", rev, path, prior: tombstone.prior };
}

const pull = { source: "upstream" as const };

describe("read-write passthrough mounts under container pulls", () => {
  it("absorbs a replayed file entry after the agent wrote", async () => {
    const mount = writableMount();
    const ws = open({ [ROOT]: mount });
    const { entry, objects } = await fileEntry(`${ROOT}/a.md`, "container\n", 11);

    expect((await applyChanges(ws.db, [entry], objects, pull)).applied).toBe(1);
    await ws.fs.writeFile(`${ROOT}/a.md`, "agent\n");
    mount.calls.length = 0;
    const replay = await applyChanges(ws.db, [entry], objects, pull);
    expect(replay).toMatchObject({ applied: 0, skipped: [] });
    expect(text(mount, "a.md")).toBe("agent\n");
    expect(mount.calls.filter((call) => call.method === "writeFile")).toEqual([]);

    // A new change to the same path, with a later sender rev, still lands.
    const next = await fileEntry(`${ROOT}/a.md`, "container, again\n", 12);
    expect((await applyChanges(ws.db, [next.entry], next.objects, pull)).applied).toBe(1);
    expect(text(mount, "a.md")).toBe("container, again\n");
  });

  it("leaves a file the mount already holds byte for byte alone", async () => {
    const mount = writableMount({ "same.md": "same\n" });
    const ws = open({ [ROOT]: mount });
    const { entry, objects } = await fileEntry(`${ROOT}/same.md`, "same\n", 5);
    expect(await applyChanges(ws.db, [entry], objects, pull)).toMatchObject({ skipped: [] });
    expect(mount.calls).toEqual([]);
  });

  it("absorbs a replayed delete after the agent wrote the path again", async () => {
    const mount = writableMount({ "a.md": "v1\n" });
    const ws = open({ [ROOT]: mount });
    const remove = await deleteEntry(`${ROOT}/a.md`, "v1\n", 20);

    expect((await applyChanges(ws.db, [remove], new Map(), pull)).applied).toBe(1);
    expect(mount.files.has("a.md")).toBe(false);
    await ws.fs.writeFile(`${ROOT}/a.md`, "agent\n");
    await applyChanges(ws.db, [remove], new Map(), pull);
    expect(text(mount, "a.md")).toBe("agent\n");

    // Without bookkeeping to go on, prior alone keeps a newer file.
    const fresh = writableMount({ "b.md": "agent's\n" });
    const other = open({ [ROOT]: fresh });
    await applyChanges(other.db, [await deleteEntry(`${ROOT}/b.md`, "v1\n", 21)], new Map(), pull);
    expect(text(fresh, "b.md")).toBe("agent's\n");
    // Whatever mode the mount reports, matching bytes are removed.
    fresh.files.set("c.md", { bytes: encoder.encode("v1\n"), mode: 0o600 });
    await applyChanges(other.db, [await deleteEntry(`${ROOT}/c.md`, "v1\n", 22)], new Map(), pull);
    expect(fresh.files.has("c.md")).toBe(false);
  });

  it("removes a pulled directory once the deletes of its contents have run", async () => {
    const mount = writableMount({ "d/x.md": "x\n" });
    const ws = open({ [ROOT]: mount });
    const scratch = new Workspace({ storage: new SQLiteTestStorage() });
    await scratch.fs.mkdir("/d");
    await scratch.fs.rm("/d");
    const dirTombstone = materialiseChange(scratch.db, "/d") as ChangeEntry & { kind: "delete" };
    const result = await applyChanges(
      ws.db,
      [
        { kind: "delete", rev: 30, path: `${ROOT}/d`, prior: dirTombstone.prior },
        await deleteEntry(`${ROOT}/d/x.md`, "x\n", 30),
      ],
      new Map(),
      pull,
    );
    expect(result.skipped).toEqual([]);
    expect(mount.dirs.has("d")).toBe(false);
  });

  it("fails the pull when a file's chunks are missing, without calling the mount", async () => {
    const mount = writableMount();
    const ws = open({ [ROOT]: mount });
    const { entry } = await fileEntry(`${ROOT}/a.md`, "lost\n", 40);
    await expect(applyChanges(ws.db, [entry], new Map(), pull)).rejects.toThrow(/missing object/);
    const wrong = await fileEntry(`${ROOT}/a.md`, "lost\n", 41);
    const [key] = [...wrong.objects.keys()];
    await expect(
      applyChanges(
        ws.db,
        [wrong.entry],
        new Map([[key, encoder.encode("not the size it says")]]),
        pull,
      ),
    ).rejects.toThrow(/declares \d+ bytes but holds/);
    expect(mount.calls).toEqual([]);
  });
});

describe("read-write passthrough mounts and their writers", () => {
  it("moves the store's revision on every write the mount takes", async () => {
    const mount = writableMount({ "a.md": "a" });
    const ws = open({ [ROOT]: mount });
    const revs = [currentRev(ws.db)];
    await ws.fs.writeFile(`${ROOT}/b.md`, "b");
    revs.push(currentRev(ws.db));
    await ws.fs.mkdir(`${ROOT}/d`);
    revs.push(currentRev(ws.db));
    await ws.fs.rename(`${ROOT}/b.md`, `${ROOT}/d/b.md`);
    revs.push(currentRev(ws.db));
    await ws.fs.chmod(`${ROOT}/a.md`, 0o600);
    revs.push(currentRev(ws.db));
    await ws.fs.rm(`${ROOT}/d`, { recursive: true });
    revs.push(currentRev(ws.db));
    expect(new Set(revs).size).toBe(revs.length);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    const before = currentRev(ws.db);
    await expect(ws.fs.rm(`${ROOT}/missing`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(currentRev(ws.db)).toBe(before);
    const stored = ws.db.one<{ v: number }>("SELECT v FROM vfs_meta WHERE k = 'rev'");
    expect(stored?.v).toBe(before);
  });

  it("aborts the write's signal when the caller's body fails, and cancels one never read", async () => {
    let signal: AbortSignal | undefined;
    const mount = writableMount();
    const reading = mount.writeFile?.bind(mount);
    mount.writeFile = async (path, body, options) => {
      signal = options.signal;
      if (path === "refused.md") throw fail("EACCES", path);
      return reading?.(path, body, options);
    };
    const ws = open({ [ROOT]: mount });

    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("caller's stream broke"));
      },
    });
    await expect(ws.fs.writeFile(`${ROOT}/a.md`, broken)).rejects.toBeDefined();
    expect(signal?.aborted).toBe(true);

    let cancelled = false;
    const unread = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    await expect(ws.fs.writeFile(`${ROOT}/refused.md`, unread)).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it("treats a missing parent as gone for rm -f, as the store does", async () => {
    const mount = writableMount({ "file.md": "f" });
    mount.rm = async (path) => {
      throw fail("ENOTDIR", path);
    };
    const ws = open({ [ROOT]: mount });
    await ws.fs.rm(`${ROOT}/file.md/below`, { force: true });
    await expect(ws.fs.rm(`${ROOT}/file.md/below`)).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("moves files into and out of the mount from the worker shell", async () => {
    const mount = writableMount({ "out.md": "out\n", "outdir/x.md": "x\n" });
    const ws = open({ [ROOT]: mount });
    const shell = new WorkspaceFsAdapter(ws.stub().fs);
    await ws.fs.writeFile("/in.md", "in\n");
    await ws.fs.mkdir("/indir/sub", { recursive: true });
    await ws.fs.writeFile("/indir/sub/y.md", "y\n");

    await shell.mv("/in.md", `${ROOT}/in.md`);
    await shell.mv("/indir", `${ROOT}/indir`);
    await shell.mv(`${ROOT}/out.md`, "/out.md");
    await shell.mv(`${ROOT}/outdir`, "/outdir");

    expect(text(mount, "in.md")).toBe("in\n");
    expect(text(mount, "indir/sub/y.md")).toBe("y\n");
    expect(mount.files.has("out.md")).toBe(false);
    expect(mount.dirs.has("outdir")).toBe(false);
    expect(await ws.fs.readFile("/out.md", "utf8")).toBe("out\n");
    expect(await ws.fs.readFile("/outdir/x.md", "utf8")).toBe("x\n");
    await expect(ws.fs.stat("/in.md")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(ws.fs.stat("/indir")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("takes codemode's file writes", async () => {
    const mount = writableMount();
    const ws = open({ [ROOT]: mount });
    const code = new WorkspaceRuntimeCapability(ws.fs, "/", "read-write");
    await code.writeFile(`${ROOT}/notes/a.md`, "from code\n");
    await code.writeFileNode(`${ROOT}/b.md`, "node:fs\n", { flag: "wx" });
    await expect(code.writeFileNode(`${ROOT}/b.md`, "again", { flag: "wx" })).rejects.toMatchObject(
      { code: "EEXIST" },
    );
    await code.mkdir(`${ROOT}/made`);
    await code.rm(`${ROOT}/notes`, { recursive: true });
    expect(text(mount, "b.md")).toBe("node:fs\n");
    expect(mount.dirs.has("made")).toBe(true);
    expect(mount.dirs.has("notes")).toBe(false);
    expect(storedNames(ws)).not.toContain("b.md");
  });

  it("lets git track a mount inside a stored worktree", async () => {
    const mount = writableMount();
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      mounts: { "/proj/kb": mount },
      git: createGitClient(),
      defaultGitIdentity: { name: "Test", email: "test@example.com" },
    });
    await ws.git.init({ dir: "/proj" });
    await ws.fs.writeFile("/proj/a.md", "stored\n");
    await ws.fs.writeFile("/proj/kb/k.md", "mounted\n");
    await ws.git.add({ dir: "/proj", paths: ["a.md", "kb/k.md"] });
    await ws.git.commit({ dir: "/proj", message: "one" });
    await ws.git.branch({ dir: "/proj", name: "two", checkout: true });
    await ws.fs.writeFile("/proj/kb/k.md", "mounted, changed\n");
    await ws.git.add({ dir: "/proj", paths: ["kb/k.md"] });
    await ws.git.commit({ dir: "/proj", message: "two" });

    await ws.git.checkout({ dir: "/proj", ref: "main" });
    expect(text(mount, "k.md")).toBe("mounted\n");
    await ws.git.checkout({ dir: "/proj", ref: "two" });
    expect(text(mount, "k.md")).toBe("mounted, changed\n");
    // The repository is the store's; only the worktree files under the
    // root are the mount's.
    expect([...mount.files.keys()]).toEqual(["k.md"]);
    expect(storedNames(ws)).toContain(".git");
  });

  it("keeps read-only mounts read-only through links", async () => {
    const readOnly = { ...writableMount({ "r.md": "r" }), mode: "read-only" as const };
    const ws = open({ "/ro": readOnly });
    await ws.fs.symlink("/ro", "/rolink");
    await ws.fs.symlink("/ro/r.md", "/rofile");
    const provider = ws.provider();
    for (const [name, attempt] of [
      ["writeFile", () => ws.fs.writeFile("/rolink/x.md", "x")],
      ["writeFile over", () => ws.fs.writeFile("/rofile", "x")],
      ["mkdir", () => ws.fs.mkdir("/rolink/d")],
      ["rm", () => ws.fs.rm("/rolink/r.md")],
      ["rename", () => ws.fs.rename("/rolink/r.md", "/rolink/s.md")],
      ["chmod", () => ws.fs.chmod("/rofile", 0o600)],
      ["symlink", () => ws.fs.symlink("/x", "/rolink/l")],
      ["provider writeFile", () => provider.writeFile("/rolink/x.md", "x")],
      ["provider mkdir", () => provider.mkdir("/rolink/d")],
      ["provider unlink", () => provider.unlink("/rolink/r.md")],
      ["provider rename", () => provider.rename("/rolink/r.md", "/x.md")],
    ] as const) {
      await expect(attempt(), name).rejects.toMatchObject({ code: "EROFS" });
    }
    expect(readOnly.calls).toEqual([]);
  });
});

describe("read-write passthrough mounts and the sync protocol", () => {
  it("counts only the pull's own revs when the host writes while a mount call is in flight", async () => {
    const mount = writableMount();
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = mount.writeFile?.bind(mount);
    mount.writeFile = async (path, body, options) => {
      started();
      await gate;
      return write?.(path, body, options);
    };
    const ws = open({ [ROOT]: mount });
    await ws.fs.writeFile("/host.txt", "old\n");
    // Everything so far has reached the container: the pull starts clean.
    writePushCursor(ws.db, { rev: currentRev(ws.db), path: null });
    const startRev = currentRev(ws.db);

    const { entry, objects } = await fileEntry(`${ROOT}/a.md`, "pulled\n", 50);
    const applying = applyChanges(
      ws.db,
      [entry, { kind: "delete", rev: 51, path: "/host.txt" }],
      objects,
      pull,
    );
    await inFlight;
    await ws.fs.writeFile("/host.txt", "written while the mount call waited\n");
    release();
    const result = await applying;

    // One rev came from the pull, one from the host: acknowledgePulledRevs
    // compares the two and leaves this window unacknowledged.
    expect(result.minted).toBe(1);
    expect(currentRev(ws.db) - startRev).toBe(2);
    // The host's write was not mistaken for the pull's: the pulled
    // delete yields to it, and it is still to be pushed.
    expect(await ws.fs.readFile("/host.txt", "utf8")).toBe("written while the mount call waited\n");
    const host = materialiseChange(ws.db, "/host.txt");
    expect(host?.rev).toBeGreaterThan(readPushCursor(ws.db).rev);
    expect(text(mount, "a.md")).toBe("pulled\n");
  });

  it("reports a pulled directory delete it keeps, and records it only once removed", async () => {
    const mount = writableMount({ "d/agent.md": "agent's\n" });
    const ws = open({ [ROOT]: mount });
    const scratch = new Workspace({ storage: new SQLiteTestStorage() });
    await scratch.fs.mkdir("/d");
    await scratch.fs.rm("/d");
    const tombstone = materialiseChange(scratch.db, "/d") as ChangeEntry & { kind: "delete" };
    const remove: ChangeEntry = {
      kind: "delete",
      rev: 60,
      path: `${ROOT}/d`,
      prior: tombstone.prior,
    };

    const first = await applyChanges(ws.db, [remove], new Map(), pull);
    expect(first.skipped).toEqual([
      expect.objectContaining({ path: `${ROOT}/d`, op: "delete", reason: "kept" }),
    ]);
    expect(mount.files.has("d/agent.md")).toBe(true);
    expect(ws.db.all("SELECT path FROM _vfs_mount_applied")).toEqual([]);

    await ws.fs.rm(`${ROOT}/d/agent.md`);
    const replay = await applyChanges(ws.db, [remove], new Map(), pull);
    expect(replay).toMatchObject({ applied: 1, skipped: [] });
    expect(mount.dirs.has("d")).toBe(false);
  });

  it("forgets what it applied once the fetch cursor passes it, the log restarts or the mount goes", async () => {
    const storage = new SQLiteTestStorage();
    const mount = writableMount();
    const ws = open({ [ROOT]: mount }, storage);
    const rows = () =>
      ws.db.all<{ path: string; rev: number }>(
        "SELECT path, rev FROM _vfs_mount_applied ORDER BY rev",
      );
    const pulled = async (name: string, rev: number) => {
      const { entry, objects } = await fileEntry(`${ROOT}/${name}`, name, rev);
      await applyChanges(ws.db, [entry], objects, pull);
    };
    await pulled("a.md", 70);
    await pulled("b.md", 71);
    await pulled("c.md", 72);
    expect(rows().map((row) => row.rev)).toEqual([70, 71, 72]);

    writeFetchCursor(ws.db, { rev: 71, path: null });
    expect(rows().map((row) => row.rev)).toEqual([72]);
    writeFetchCursor(ws.db, { rev: 72, path: `${ROOT}/a.md` });
    expect(rows().map((row) => row.rev)).toEqual([72]);
    // The backend's log started over.
    writeFetchCursor(ws.db, { rev: 0, path: null });
    expect(rows()).toEqual([]);

    await pulled("d.md", 3);
    expect(rows()).toHaveLength(1);
    // Opened again without that mount, among others, its rows go.
    const again = open({ "/other": writableMount() }, storage);
    expect(again.db.all("SELECT path FROM _vfs_mount_applied")).toEqual([]);
  });

  it("cancels the caller's body a mount didn't read to its end", async () => {
    const mount = writableMount();
    mount.writeFile = async () => undefined;
    const ws = open({ [ROOT]: mount });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("more"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await ws.fs.writeFile(`${ROOT}/ignored.md`, body);
    expect(cancelled).toBe(true);
  });

  it("keeps an entry the mount took applied when its record can't be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mount = writableMount();
      const ws = open({ [ROOT]: mount });
      ws.db.run("DROP TABLE _vfs_mount_applied");
      ws.db.run(
        "CREATE TABLE _vfs_mount_applied (backend TEXT, path TEXT, rev INTEGER, digest TEXT, CHECK (rev < 0))",
      );
      const { entry, objects } = await fileEntry(`${ROOT}/a.md`, "a\n", 80);
      const result = await applyChanges(ws.db, [entry], objects, pull);
      expect(result).toMatchObject({ applied: 1, skipped: [] });
      expect(text(mount, "a.md")).toBe("a\n");
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ path: `${ROOT}/a.md` }));
    } finally {
      warn.mockRestore();
    }
  });
});
