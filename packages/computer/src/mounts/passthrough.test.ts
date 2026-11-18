import {
  applyChanges,
  createWorkspaceError,
  PASSTHROUGH_WALK_LIMIT,
  readOnlyRootFor,
} from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it, vi } from "vitest";

import { buildModuleGraph } from "../backends/codemode/module-graph";
import { WorkspaceFsAdapter } from "../backends/worker-shell/adapter";
import { WorkspaceRuntimeCapability } from "../runtime/capability";
import { Workspace } from "../workspace";
import type { PassthroughDirent, PassthroughMount, PassthroughStat } from "./types";

const ROOT = "/skills/team";

interface FakeOptions {
  // Serve ranged reads from the requested offset. Otherwise every read
  // returns the whole file from offset 0, like a source that can't seek.
  seek?: boolean;
  // Override what a method returns or throws, per call.
  stat?: PassthroughMount["stat"];
  readdir?: PassthroughMount["readdir"];
  readFile?: PassthroughMount["readFile"];
}

type FakeMount = PassthroughMount & {
  calls: Array<{ method: string; path: string; options?: unknown }>;
};

// An in-memory passthrough mount over `files`, keyed by path relative
// to the mount root. Directories are implied by the file paths.
function fakePassthrough(files: Record<string, string>, options: FakeOptions = {}): FakeMount {
  const encoder = new TextEncoder();
  const bytes = new Map(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)]));
  const dirs = new Set<string>([""]);
  for (const path of bytes.keys()) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join("/"));
  }
  const statOf = (path: string): PassthroughStat | null => {
    const file = bytes.get(path);
    if (file !== undefined)
      return { type: "file", size: file.byteLength, mtime: 1_000, mode: 0o644 };
    if (dirs.has(path)) return { type: "dir", size: 0, mtime: 2_000, mode: 0o755 };
    return null;
  };
  const calls: FakeMount["calls"] = [];
  return {
    kind: "fake-passthrough",
    strategy: "passthrough",
    mode: "read-only",
    calls,
    async stat(path, opts) {
      calls.push({ method: "stat", path, options: opts });
      if (options.stat) return options.stat(path, opts);
      return statOf(path);
    },
    async readdir(path, opts) {
      calls.push({ method: "readdir", path, options: opts });
      if (options.readdir) return options.readdir(path, opts);
      if (bytes.has(path)) throw createWorkspaceError("ENOTDIR", "not a directory", path);
      if (!dirs.has(path)) return null;
      const prefix = path === "" ? "" : `${path}/`;
      const names = [...dirs, ...bytes.keys()]
        .filter((name) => name !== "" && name.startsWith(prefix) && name !== path)
        .map((name) => name.slice(prefix.length))
        .filter((name) => opts?.recursive === true || !name.includes("/"))
        // Parents before children.
        .sort((a, b) => a.split("/").length - b.split("/").length);
      return names.map((name): PassthroughDirent => ({
        name,
        ...(statOf(`${prefix}${name}`) as PassthroughStat),
      }));
    },
    async readFile(path, opts) {
      calls.push({ method: "readFile", path, options: opts });
      if (options.readFile) return options.readFile(path, opts);
      const file = bytes.get(path);
      if (file === undefined) return null;
      const stat = statOf(path) as PassthroughStat;
      if (options.seek && opts?.range) {
        const start = opts.range.offset;
        const end = opts.range.length === undefined ? file.byteLength : start + opts.range.length;
        return { stat, body: streamOf(file.slice(start, end)), offset: start };
      }
      return { stat, body: streamOf(file), offset: 0 };
    },
  };
}

// A body in chunks of at most three bytes, so windows cross chunks.
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + 3));
      offset += 3;
    },
  });
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

const FILES = {
  "README.md": "# Team skills\nUse them well.\n",
  "pdf/SKILL.md": "---\nname: pdf\n---\nRead PDFs with care.\n",
  "pdf/lib/extract.js": 'export const extract = () => "pages";\n',
  "pdf/lib/util.js":
    'import { extract } from "./extract.js";\nexport const run = () => extract();\n',
};

function open(mount: PassthroughMount | undefined, storage = new SQLiteTestStorage()) {
  const ws = new Workspace({
    storage,
    now: () => 5_000,
    ...(mount === undefined ? {} : { mounts: { [ROOT]: mount } }),
  });
  return ws;
}

function readdirCalls(mount: FakeMount) {
  return mount.calls.filter((call) => call.method === "readdir");
}

describe("passthrough mounts", () => {
  it("stats the root, directories and files from the mount", async () => {
    const mount = fakePassthrough(FILES);
    const ws = open(mount);

    const root = await ws.fs.stat(ROOT);
    expect(root).toMatchObject({ name: "team", isDirectory: true, mtime: 2_000, mode: 0o755 });
    expect(await ws.fs.stat(`${ROOT}/pdf`)).toMatchObject({ isDirectory: true, size: 0 });
    expect(await ws.fs.stat(`${ROOT}/pdf/SKILL.md`)).toMatchObject({
      name: "SKILL.md",
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      size: FILES["pdf/SKILL.md"].length,
      mtime: 1_000,
      mode: 0o644,
    });
    expect(await ws.fs.lstat(`${ROOT}/README.md`)).toMatchObject({ isFile: true });
    expect(mount.calls.map((call) => call.path)).toEqual(["", "pdf", "pdf/SKILL.md", "README.md"]);

    await expect(ws.fs.stat(`${ROOT}/missing.md`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(ws.fs.readlink(`${ROOT}/README.md`)).rejects.toMatchObject({ code: "EINVAL" });
    await expect(ws.fs.readlink(`${ROOT}/nope`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await ws.stub().fs.exists(`${ROOT}/README.md`)).toBe(true);
    expect(await ws.stub().fs.exists(`${ROOT}/nope`)).toBe(false);
  });

  it("lists the root as a directory of its parent, which is an ordinary directory", async () => {
    const mount = fakePassthrough(FILES);
    const ws = open(mount);
    await ws.fs.writeFile("/skills/local.md", "mine");

    const skills = await ws.fs.readdir("/skills");
    expect(skills.map((entry) => [entry.name, entry.isDirectory])).toEqual([
      ["local.md", false],
      ["team", true],
    ]);
    expect(skills[1]).toMatchObject({ parentPath: "/skills", mtime: 2_000 });
    expect((await ws.fs.stat("/skills")).isDirectory).toBe(true);
    expect(await ws.fs.find("/", "skills/*")).toEqual([
      { path: "/skills/local.md", type: "file" },
      { path: ROOT, type: "dir" },
    ]);
  });

  it("reads directories from the mount, in name order, with paging", async () => {
    const mount = fakePassthrough(FILES);
    const ws = open(mount);

    const entries = await ws.fs.readdir(ROOT);
    expect(entries.map((entry) => [entry.name, entry.isFile, entry.isDirectory])).toEqual([
      ["README.md", true, false],
      ["pdf", false, true],
    ]);
    expect(entries[0]).toMatchObject({ parentPath: ROOT, size: FILES["README.md"].length });
    expect((await ws.fs.readdir(`${ROOT}/pdf`)).map((entry) => entry.name)).toEqual([
      "SKILL.md",
      "lib",
    ]);
    expect(
      (await ws.fs.readdir(`${ROOT}/pdf`, { offset: 1, limit: 1 })).map((entry) => entry.name),
    ).toEqual(["lib"]);
    await expect(ws.fs.readdir(`${ROOT}/README.md`)).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(ws.fs.readdir(`${ROOT}/nope`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["a mount that seeks", true],
    ["a mount that can't seek", false],
  ])("reads files, whole, as utf8 and by range, from %s", async (_name, seek) => {
    const mount = fakePassthrough({ "notes.txt": "0123456789abcdef" }, { seek });
    const ws = open(mount);
    const path = `${ROOT}/notes.txt`;

    expect(await text(await ws.fs.readFile(path))).toBe("0123456789abcdef");
    expect(await ws.fs.readFile(path, "utf8")).toBe("0123456789abcdef");
    expect(await ws.fs.readFile(path, { encoding: "utf8", byteOffset: 4, byteLength: 5 })).toBe(
      "45678",
    );
    expect(await text(await ws.fs.readFile(path, { byteOffset: 10 }))).toBe("abcdef");
    expect(await ws.fs.readFile(path, { encoding: "utf8", byteOffset: 14, byteLength: 10 })).toBe(
      "ef",
    );
    expect(await ws.fs.readFile(path, { encoding: "utf8", byteOffset: 40 })).toBe("");
    const reads = mount.calls.filter((call) => call.method === "readFile");
    for (const call of reads) {
      expect((call.options as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
    }
    expect(reads.map((call) => (call.options as { range?: unknown }).range)).toEqual([
      undefined,
      undefined,
      { offset: 4, length: 5 },
      { offset: 10 },
      { offset: 14, length: 10 },
      { offset: 40 },
    ]);

    await expect(ws.fs.readFile(`${ROOT}/nope`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(ws.fs.readFile(ROOT)).rejects.toMatchObject({ code: "EISDIR" });
    await expect(ws.fs.readFile(path, { byteOffset: -1 })).rejects.toMatchObject({
      code: "EINVAL",
    });
  });

  it("walks a mount with one recursive readdir for find, ls and grep", async () => {
    const mount = fakePassthrough(FILES);
    const ws = open(mount);

    expect(await ws.fs.find(ROOT)).toEqual([
      { path: `${ROOT}/README.md`, type: "file" },
      { path: `${ROOT}/pdf`, type: "dir" },
      { path: `${ROOT}/pdf/SKILL.md`, type: "file" },
      { path: `${ROOT}/pdf/lib`, type: "dir" },
      { path: `${ROOT}/pdf/lib/extract.js`, type: "file" },
      { path: `${ROOT}/pdf/lib/util.js`, type: "file" },
    ]);
    expect(readdirCalls(mount)).toEqual([
      {
        method: "readdir",
        path: "",
        options: {
          recursive: true,
          limit: PASSTHROUGH_WALK_LIMIT,
          signal: expect.any(AbortSignal),
        },
      },
    ]);

    expect(await ws.fs.find(ROOT, "**/*.js", { exclude: ["pdf/lib/util.js"] })).toEqual([
      { path: `${ROOT}/pdf/lib/extract.js`, type: "file" },
    ]);
    expect(await ws.fs.find(`${ROOT}/pdf`, "*", { offset: 1, limit: 1 })).toEqual([
      { path: `${ROOT}/pdf/lib`, type: "dir" },
    ]);
    expect(await ws.fs.find(ROOT, undefined, { exclude: ["pdf/lib/**"] })).toEqual([
      { path: `${ROOT}/README.md`, type: "file" },
      { path: `${ROOT}/pdf`, type: "dir" },
      { path: `${ROOT}/pdf/SKILL.md`, type: "file" },
    ]);

    expect(await ws.fs.ls(`${ROOT}/pdf`)).toEqual([
      `${ROOT}/pdf/SKILL.md`,
      `${ROOT}/pdf/lib/extract.js`,
      `${ROOT}/pdf/lib/util.js`,
    ]);
    expect(await ws.fs.ls(`${ROOT}/README.md`)).toEqual([`${ROOT}/README.md`]);
    expect(await ws.fs.ls(`${ROOT}/nope`)).toEqual([]);

    mount.calls.length = 0;
    expect(await ws.fs.grep("extract", ROOT, { include: "**/*.js" })).toEqual([
      {
        path: `${ROOT}/pdf/lib/extract.js`,
        line: 1,
        text: 'export const extract = () => "pages";',
      },
      { path: `${ROOT}/pdf/lib/util.js`, line: 1, text: 'import { extract } from "./extract.js";' },
      { path: `${ROOT}/pdf/lib/util.js`, line: 2, text: "export const run = () => extract();" },
    ]);
    expect(readdirCalls(mount)).toHaveLength(1);
    expect(await ws.fs.grep("care", `${ROOT}/pdf/SKILL.md`)).toEqual([
      { path: `${ROOT}/pdf/SKILL.md`, line: 4, text: "Read PDFs with care." },
    ]);
  });

  it("merges mounts into find, ls and grep of a directory above them", async () => {
    const mount = fakePassthrough(FILES);
    const ws = open(mount);
    await ws.fs.writeFile("/skills/local.md", "care, locally\n");
    await ws.fs.writeFile("/zeta.md", "care at the end\n");

    expect(await ws.fs.find("/", "**/*.md")).toEqual([
      { path: "/skills/local.md", type: "file" },
      { path: `${ROOT}/README.md`, type: "file" },
      { path: `${ROOT}/pdf/SKILL.md`, type: "file" },
      { path: "/zeta.md", type: "file" },
    ]);
    // ROOT sorts after "local.md" by name; its subtree goes with it.
    expect((await ws.fs.find("/skills")).map((entry) => entry.path)).toEqual([
      "/skills/local.md",
      ROOT,
      `${ROOT}/README.md`,
      `${ROOT}/pdf`,
      `${ROOT}/pdf/SKILL.md`,
      `${ROOT}/pdf/lib`,
      `${ROOT}/pdf/lib/extract.js`,
      `${ROOT}/pdf/lib/util.js`,
    ]);
    expect(await ws.fs.find("/", undefined, { exclude: ["skills/team"] })).toEqual([
      { path: "/skills", type: "dir" },
      { path: "/skills/local.md", type: "file" },
      { path: "/zeta.md", type: "file" },
    ]);
    expect(await ws.fs.ls("/")).toEqual([
      "/skills/local.md",
      `${ROOT}/README.md`,
      `${ROOT}/pdf/SKILL.md`,
      `${ROOT}/pdf/lib/extract.js`,
      `${ROOT}/pdf/lib/util.js`,
      "/zeta.md",
    ]);

    mount.calls.length = 0;
    expect((await ws.fs.grep("care", "/")).map((match) => match.path)).toEqual([
      "/skills/local.md",
      `${ROOT}/pdf/SKILL.md`,
      "/zeta.md",
    ]);
    expect(readdirCalls(mount)).toHaveLength(1);
  });

  it("imports a mounted JavaScript module into a codemode module graph", async () => {
    const ws = open(fakePassthrough(FILES));
    const capability = new WorkspaceRuntimeCapability(ws.fs, "/", "read-only");

    const graph = await buildModuleGraph({
      source: `import { run } from "${ROOT}/pdf/lib/util.js";\nexport default async () => run();\n`,
      cwd: "/",
      capability,
      configuredModules: {},
      hostModules: new Map(),
      nodeModules: false,
      maxSourceBytes: 1 << 20,
      maxCapabilityBytes: 1 << 20,
    });

    expect(Object.keys(graph.modules)).toEqual(
      expect.arrayContaining(["skills/team/pdf/lib/util.js", "skills/team/pdf/lib/extract.js"]),
    );
    expect(graph.modules["skills/team/pdf/lib/extract.js"]).toBe(FILES["pdf/lib/extract.js"]);
  });

  it("serves the worker shell's filesystem through the stub", async () => {
    const ws = open(fakePassthrough(FILES));
    const shell = new WorkspaceFsAdapter(ws.stub().fs);

    expect(await shell.readFile(`${ROOT}/README.md`)).toBe(FILES["README.md"]);
    expect(await shell.readdir(`${ROOT}/pdf`)).toEqual(["SKILL.md", "lib"]);
    expect(await shell.exists(`${ROOT}/pdf/lib`)).toBe(true);
    expect(await shell.exists(`${ROOT}/nope`)).toBe(false);
    expect((await shell.stat(ROOT)).isDirectory).toBe(true);
    await expect(shell.writeFile(`${ROOT}/x.md`, "x")).rejects.toMatchObject({ code: "EROFS" });
  });

  it("rejects writes under the root with EROFS without calling the mount", async () => {
    const mount = fakePassthrough(FILES);
    const ws = open(mount);
    await ws.fs.writeFile("/elsewhere.txt", "x");

    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["writeFile", () => ws.fs.writeFile(`${ROOT}/new.md`, "x")],
      ["writeFile over a file", () => ws.fs.writeFile(`${ROOT}/README.md`, "x")],
      ["writeFile at the root", () => ws.fs.writeFile(ROOT, "x")],
      ["mkdir", () => ws.fs.mkdir(`${ROOT}/dir`)],
      ["mkdir -p", () => ws.fs.mkdir(`${ROOT}/a/b`, { recursive: true })],
      ["rm", () => ws.fs.rm(`${ROOT}/README.md`)],
      ["rm -rf root", () => ws.fs.rm(ROOT, { recursive: true, force: true })],
      ["rename from", () => ws.fs.rename(`${ROOT}/README.md`, "/moved.md")],
      ["rename to", () => ws.fs.rename("/elsewhere.txt", `${ROOT}/elsewhere.txt`)],
      ["chmod", () => ws.fs.chmod(`${ROOT}/README.md`, 0o600)],
      ["symlink", () => ws.fs.symlink("/elsewhere.txt", `${ROOT}/link`)],
      // A directory above the root behaves as above a read-only eager mount.
      ["rm -rf ancestor", () => ws.fs.rm("/skills", { recursive: true, force: true })],
      ["rename ancestor", () => ws.fs.rename("/skills", "/skills2")],
      ["mkdir ancestor", () => ws.fs.mkdir("/skills", { recursive: true })],
      ["provider writeFileSync", async () => ws.provider().writeFileSync(`${ROOT}/x`, "x")],
      ["provider unlinkSync", async () => ws.provider().unlinkSync(`${ROOT}/README.md`)],
      ["provider openSync", async () => ws.provider().openSync(`${ROOT}/README.md`, "w")],
    ];
    for (const [name, attempt] of attempts) {
      await expect(attempt(), name).rejects.toMatchObject({ code: "EROFS" });
    }
    expect(mount.calls).toEqual([]);
    // Sync pulls from a container skip what this reports.
    expect(readOnlyRootFor(ws.db, `${ROOT}/from-container.txt`)).toBe(ROOT);
    // Beside the root, the parent is an ordinary directory.
    await ws.fs.mkdir("/skills/other");
    await ws.fs.rm("/skills/other");
  });

  it("stores nothing for the mount's paths", async () => {
    const storage = new SQLiteTestStorage();
    const ws = open(fakePassthrough(FILES), storage);
    await ws.fs.find("/");
    await ws.fs.grep("care", "/");
    await ws.fs.readFile(`${ROOT}/pdf/SKILL.md`, "utf8");
    await ws.fs.readdir(`${ROOT}/pdf/lib`);

    const names = ws.db.all<{ name: string }>("SELECT name FROM vfs_dirents").map((r) => r.name);
    expect(names).toContain("skills");
    for (const name of ["team", "README.md", "pdf", "SKILL.md", "lib", "extract.js", "util.js"]) {
      expect(names).not.toContain(name);
    }
    expect(ws.db.all("SELECT root FROM _vfs_mounts")).toEqual([]);
    expect(ws.db.all("SELECT inode FROM vfs_nodes WHERE mount_root IS NOT NULL")).toEqual([]);
    expect(ws.mounts().get(ROOT)?.strategy).toBe("passthrough");
  });

  it("serves the paths only while a Workspace is opened with the mount", async () => {
    const storage = new SQLiteTestStorage();
    const first = open(fakePassthrough(FILES), storage);
    expect(await first.fs.readFile(`${ROOT}/README.md`, "utf8")).toBe(FILES["README.md"]);

    const without = open(undefined, storage);
    await expect(without.fs.readFile(`${ROOT}/README.md`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(without.fs.stat(ROOT)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await without.fs.readdir("/skills")).toEqual([]);
    // Nothing is read-only any more.
    await without.fs.mkdir(ROOT);
    await without.fs.writeFile(`${ROOT}/mine.md`, "mine");
    await without.fs.rm(ROOT, { recursive: true });

    const again = open(fakePassthrough(FILES), storage);
    expect(await again.fs.readFile(`${ROOT}/README.md`, "utf8")).toBe(FILES["README.md"]);
    expect((await again.fs.readdir("/skills")).map((entry) => entry.name)).toEqual(["team"]);
  });

  it("fails one operation with EIO when the mount throws", async () => {
    const long = "x".repeat(5_000);
    const mount = fakePassthrough(FILES, {
      stat: async (path) => {
        if (path === "README.md") throw new Error(`upstream exploded ${long}`);
        if (path === "secret.md") throw createWorkspaceError("EACCES", "denied", path);
        return { type: "dir", size: 0, mtime: 0, mode: 0o755 };
      },
    });
    const ws = open(mount);

    const error = await ws.fs.stat(`${ROOT}/README.md`).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "EIO", path: `${ROOT}/README.md` });
    const message = (error as Error).message;
    expect(message).toContain("upstream exploded");
    expect(message.length).toBeLessThan(1_200);
    // A WorkspaceFsError from the mount passes through.
    await expect(ws.fs.stat(`${ROOT}/secret.md`)).rejects.toMatchObject({ code: "EACCES" });
    // Other operations still work.
    expect(await ws.fs.readFile(`${ROOT}/README.md`, "utf8")).toBe(FILES["README.md"]);
  });

  it("fails reads with EIO when the bytes don't match the stat", async () => {
    const reply = (size: number, body: string) => async () => ({
      stat: { type: "file" as const, size, mtime: 0, mode: 0o644 },
      body: streamOf(new TextEncoder().encode(body)),
      offset: 0,
    });
    const short = open(fakePassthrough(FILES, { readFile: reply(10, "abc") }));
    await expect(short.fs.readFile(`${ROOT}/README.md`, "utf8")).rejects.toMatchObject({
      code: "EIO",
    });
    const long = open(fakePassthrough(FILES, { readFile: reply(2, "abcdef") }));
    await expect(long.fs.readFile(`${ROOT}/README.md`, "utf8")).rejects.toMatchObject({
      code: "EIO",
    });
    const stream = await long.fs.readFile(`${ROOT}/README.md`);
    await expect(text(stream)).rejects.toMatchObject({ code: "EIO" });
    // A window the body covers reads; the rest is never fetched.
    expect(await short.fs.readFile(`${ROOT}/README.md`, { encoding: "utf8", byteLength: 2 })).toBe(
      "ab",
    );
  });

  it("fails with EIO on malformed replies", async () => {
    const listing = (entries: unknown[]) =>
      open(fakePassthrough(FILES, { readdir: async () => entries as PassthroughDirent[] }));
    const file = { type: "file", size: 1, mtime: 0, mode: 0o644 };
    const dir = { type: "dir", size: 0, mtime: 0, mode: 0o755 };

    for (const name of ["", ".", "..", "/abs", "a\\b", "a\0b", "a/b"]) {
      await expect(listing([{ ...file, name }]).fs.readdir(ROOT), name).rejects.toMatchObject({
        code: "EIO",
      });
    }
    for (const name of ["a//b", "a/./b", "a/../b", "a/"]) {
      await expect(
        listing([
          { ...dir, name: "a" },
          { ...file, name },
        ]).fs.find(ROOT),
        name,
      ).rejects.toMatchObject({ code: "EIO" });
    }
    // A child below a file, and one whose parent isn't listed.
    await expect(
      listing([
        { ...file, name: "a" },
        { ...file, name: "a/b" },
      ]).fs.find(ROOT),
    ).rejects.toMatchObject({ code: "EIO" });
    await expect(listing([{ ...file, name: "x/y" }]).fs.find(ROOT)).rejects.toMatchObject({
      code: "EIO",
    });
    await expect(
      listing([
        { ...file, name: "a" },
        { ...file, name: "a" },
      ]).fs.readdir(ROOT),
    ).rejects.toMatchObject({ code: "EIO" });
    await expect(
      listing([{ ...file, type: "socket", name: "a" }]).fs.readdir(ROOT),
    ).rejects.toMatchObject({ code: "EIO" });

    // The root must be a directory.
    const fileRoot = open(fakePassthrough(FILES, { stat: async () => file as PassthroughStat }));
    await expect(fileRoot.fs.stat(ROOT)).rejects.toMatchObject({ code: "EIO" });
  });

  it("rejects synchronous reads with ENOTSUP and serves the provider's async ones", async () => {
    const ws = open(fakePassthrough(FILES));
    const provider = ws.provider();
    const path = `${ROOT}/README.md`;

    expect(() => provider.statSync(path)).toThrow(expect.objectContaining({ code: "ENOTSUP" }));
    expect(() => provider.readFileSync(path)).toThrow(expect.objectContaining({ code: "ENOTSUP" }));
    expect(() => provider.existsSync(path)).toThrow(expect.objectContaining({ code: "ENOTSUP" }));
    expect(() => provider.readdirSync(ROOT)).toThrow(expect.objectContaining({ code: "ENOTSUP" }));

    expect((await provider.stat(path)).isFile()).toBe(true);
    expect(await provider.readFile(path, "utf8")).toBe(FILES["README.md"]);
    expect(await provider.readdir(ROOT)).toEqual(["README.md", "pdf"]);
    expect(await provider.readdir("/skills")).toEqual(["team"]);
    expect(await provider.exists(path)).toBe(true);
    expect(await provider.exists(`${ROOT}/nope`)).toBe(false);
    expect(await provider.realpath(`${ROOT}/pdf/../README.md`)).toBe(path);
  });

  it("refuses a root inside or around another mount", () => {
    const eager = {
      kind: "fake",
      mode: "read-only" as const,
      strategy: "eager" as const,
      materialize: async () => {},
    };
    expect(
      () =>
        new Workspace({
          storage: new SQLiteTestStorage(),
          mounts: { "/skills": eager, [ROOT]: fakePassthrough(FILES) },
        }),
    ).toThrow(/must not nest/);
    expect(
      () =>
        new Workspace({
          storage: new SQLiteTestStorage(),
          mounts: { [ROOT]: fakePassthrough(FILES), [`${ROOT}/pdf`]: fakePassthrough(FILES) },
        }),
    ).toThrow(/must not nest/);
    expect(
      () =>
        new Workspace({
          storage: new SQLiteTestStorage(),
          mounts: { "/": fakePassthrough(FILES) },
        }),
    ).toThrow(/can't be at \//);
  });
});

describe("passthrough mounts in walks, links and syncs", () => {
  it("reads a root through symbolic links, never the rows under it", async () => {
    const storage = new SQLiteTestStorage();
    // Rows left under the root from before it was a passthrough mount.
    const before = open(undefined, storage);
    await before.fs.mkdir(`${ROOT}/pdf`, { recursive: true });
    await before.fs.writeFile(`${ROOT}/README.md`, "STALE\n");
    await before.fs.writeFile(`${ROOT}/stale.md`, "STALE\n");
    await before.fs.symlink(ROOT, "/dirlink");
    await before.fs.symlink(`${ROOT}/README.md`, "/filelink");
    await before.fs.symlink("/skills", "/skillslink");
    await before.fs.symlink("dirlink/pdf/../README.md", "/dotlink");

    const ws = open(fakePassthrough(FILES), storage);
    expect(await ws.fs.readFile("/filelink", "utf8")).toBe(FILES["README.md"]);
    expect(await ws.fs.readFile("/dirlink/pdf/SKILL.md", "utf8")).toBe(FILES["pdf/SKILL.md"]);
    expect(await ws.fs.readFile("/dotlink", "utf8")).toBe(FILES["README.md"]);
    expect(await ws.fs.stat("/dirlink")).toMatchObject({ name: "dirlink", isDirectory: true });
    expect(await ws.fs.lstat("/dirlink")).toMatchObject({ isSymbolicLink: true });
    expect(await ws.fs.readlink("/dirlink")).toBe(ROOT);
    await expect(ws.fs.readFile("/dirlink/stale.md")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await ws.fs.readdir("/dirlink")).map((entry) => entry.name)).toEqual([
      "README.md",
      "pdf",
    ]);
    expect((await ws.fs.readdir("/skillslink")).map((entry) => entry.name)).toEqual(["team"]);
    expect((await ws.fs.find("/dirlink", "**/*.md")).map((entry) => entry.path)).toEqual([
      "/dirlink/README.md",
      "/dirlink/pdf/SKILL.md",
    ]);
    expect((await ws.fs.find("/skillslink", "**/*.md")).map((entry) => entry.path)).toEqual([
      "/skillslink/team/README.md",
      "/skillslink/team/pdf/SKILL.md",
    ]);
    const grepped = await ws.fs.grep("STALE|care", "/", { regex: true });
    expect(grepped.map((match) => match.path)).toEqual([`${ROOT}/pdf/SKILL.md`]);
    expect(await ws.provider().readFile("/filelink", "utf8")).toBe(FILES["README.md"]);
    expect(() => ws.provider().statSync("/filelink")).toThrow(
      expect.objectContaining({ code: "ENOTSUP" }),
    );

    const writes: Array<[string, () => Promise<unknown>]> = [
      ["writeFile into", () => ws.fs.writeFile("/dirlink/new.md", "x")],
      ["writeFile over", () => ws.fs.writeFile("/filelink", "x")],
      ["mkdir", () => ws.fs.mkdir("/dirlink/d")],
      ["rm", () => ws.fs.rm("/dirlink/README.md")],
      ["rename from", () => ws.fs.rename("/dirlink/README.md", "/moved.md")],
      ["rename to", () => ws.fs.rename("/dotlink", "/dirlink/moved.md")],
      ["chmod", () => ws.fs.chmod("/filelink", 0o600)],
      ["provider writeFileSync", async () => ws.provider().writeFileSync("/filelink", "x")],
      ["provider unlinkSync", async () => ws.provider().unlinkSync("/dirlink/README.md")],
    ];
    for (const [name, attempt] of writes) {
      await expect(attempt(), name).rejects.toMatchObject({ code: "EROFS" });
    }
    // The store doesn't create a link through a link at all.
    await expect(ws.fs.symlink("/x", "/dirlink/l")).rejects.toMatchObject({ code: "ENOTDIR" });
    // The links themselves are ordinary files of the store.
    await ws.fs.rm("/filelink");
  });

  it("skips changes pulled from a container under a root or above it", async () => {
    const ws = open(fakePassthrough(FILES));
    const file = (path: string) => ({
      kind: "file" as const,
      rev: 100,
      path,
      mode: 0o644,
      mtime: 1,
      size: 0,
      chunks: [],
    });
    const result = await applyChanges(
      ws.db,
      [
        file(`${ROOT}/from-container.md`),
        file("/skills/beside.md"),
        { kind: "delete", rev: 101, path: `${ROOT}/README.md` },
        { kind: "delete", rev: 102, path: "/skills" },
      ],
      new Map(),
    );
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: `${ROOT}/from-container.md`, mountRoot: ROOT }),
        expect.objectContaining({ path: `${ROOT}/README.md`, mountRoot: ROOT, op: "delete" }),
        expect.objectContaining({ path: "/skills", mountRoot: ROOT, op: "delete" }),
      ]),
    );
    expect(await ws.fs.readFile("/skills/beside.md", "utf8")).toBe("");
    expect(await ws.fs.readFile(`${ROOT}/README.md`, "utf8")).toBe(FILES["README.md"]);
    const names = ws.db.all<{ name: string }>("SELECT name FROM vfs_dirents").map((r) => r.name);
    expect(names).not.toContain("from-container.md");
  });

  it("skips changes pulled through a store link into a root", async () => {
    const ws = open(fakePassthrough(FILES));
    await ws.fs.symlink(ROOT, "/dirlink");
    await ws.fs.symlink("/skills", "/skillslink");
    const file = (path: string) => ({
      kind: "file" as const,
      rev: 100,
      path,
      mode: 0o644,
      mtime: 1,
      size: 0,
      chunks: [],
    });
    const result = await applyChanges(
      ws.db,
      [
        file("/dirlink/from-container.md"),
        { kind: "dir", rev: 101, path: "/dirlink/sub", mode: 0o755, mtime: 1 },
        { kind: "symlink", rev: 102, path: "/skillslink/team/l", target: "/x", mtime: 1 },
        { kind: "delete", rev: 103, path: "/dirlink/README.md" },
        file("/beside.md"),
      ],
      new Map(),
      { source: "upstream" },
    );
    expect(result.skipped).toEqual([
      { path: "/dirlink/from-container.md", mountRoot: ROOT, op: "write", reason: "read-only" },
      { path: "/dirlink/sub", mountRoot: ROOT, op: "write", reason: "read-only" },
      { path: "/skillslink/team/l", mountRoot: ROOT, op: "write", reason: "read-only" },
      { path: "/dirlink/README.md", mountRoot: ROOT, op: "delete", reason: "read-only" },
    ]);
    expect(result.applied).toBe(1);
    expect(await ws.fs.readFile("/beside.md", "utf8")).toBe("");
    expect(await ws.fs.readFile("/dirlink/README.md", "utf8")).toBe(FILES["README.md"]);
    const names = ws.db.all<{ name: string }>("SELECT name FROM vfs_dirents").map((r) => r.name);
    expect(names).not.toContain("from-container.md");
  });

  it("holds only the bytes a mount sends, whatever size it states", async () => {
    const huge = 3 * 2 ** 30;
    const ws = open(
      fakePassthrough(FILES, {
        readFile: async () => ({
          stat: { type: "file", size: huge, mtime: 0, mode: 0o644 },
          offset: 0,
          body: streamOf(new TextEncoder().encode("abc")),
        }),
      }),
    );
    const path = `${ROOT}/README.md`;
    await expect(ws.fs.readFile(path, "utf8")).rejects.toMatchObject({ code: "EIO" });
    await expect(ws.provider().readFile(path)).rejects.toMatchObject({ code: "EIO" });
    expect(await ws.fs.readFile(path, { encoding: "utf8", byteLength: 2 })).toBe("ab");
    expect((await ws.fs.stat(path)).size).toBe(FILES["README.md"].length);
  });

  it("fails a walk with EIO when a mount lists more than the limit", async () => {
    const entries = Array.from({ length: PASSTHROUGH_WALK_LIMIT + 1 }, (_, index) => ({
      name: `f${index}`,
      type: "file" as const,
      size: 0,
      mtime: 0,
      mode: 0o644,
    }));
    const ws = open(
      fakePassthrough(FILES, {
        readdir: async (_path, opts) => (opts?.recursive ? entries : []),
      }),
    );
    await expect(ws.fs.find(ROOT)).rejects.toMatchObject({ code: "EIO" });
    await expect(ws.fs.ls(ROOT)).rejects.toMatchObject({ code: "EIO" });
    expect(await ws.fs.readdir(ROOT)).toEqual([]);
  });

  it("stops find and grep at their limits without walking a mount it doesn't reach", async () => {
    const mount = fakePassthrough(FILES);
    const ws = open(mount);
    await ws.fs.writeFile("/a.md", "care first\ncare again\n");

    expect(await ws.fs.find("/", undefined, { limit: 1 })).toEqual([
      { path: "/a.md", type: "file" },
    ]);
    expect(await ws.fs.find(ROOT, undefined, { limit: 0 })).toEqual([]);
    expect(await ws.fs.grep("care", "/", { limit: 1 })).toEqual([
      { path: "/a.md", line: 1, text: "care first" },
    ]);
    // A glob whose literal start rules the mount out.
    expect(await ws.fs.find("/", "a*/**")).toEqual([]);
    expect(await ws.fs.find("/", "skills/other/**")).toEqual([]);
    expect(await ws.fs.find("/", "*/t?am2/**")).toEqual([]);
    expect(await ws.fs.find("/", "skills")).toEqual([{ path: "/skills", type: "dir" }]);
    expect(mount.calls).toEqual([]);

    // A walk that stops after the mount's first entry aborts its call.
    expect(await ws.fs.find("/skills", undefined, { limit: 1 })).toEqual([
      { path: ROOT, type: "dir" },
    ]);
    const [walk] = readdirCalls(mount);
    expect((walk.options as { signal: AbortSignal }).signal.aborted).toBe(true);
    // One that runs to its end doesn't.
    mount.calls.length = 0;
    await ws.fs.find("/skills", "**/*.md");
    expect((readdirCalls(mount)[0].options as { signal: AbortSignal }).signal.aborted).toBe(false);
  });

  it("cancels the body and aborts the read when grep stops early", async () => {
    const line = new TextEncoder().encode("care\n");
    const lines = 1_000;
    let pulled = 0;
    let cancelled = false;
    let signal: AbortSignal | undefined;
    const ws = open(
      fakePassthrough(FILES, {
        readFile: async (_path, opts) => {
          signal = opts?.signal;
          return {
            stat: { type: "file", size: line.byteLength * lines, mtime: 0, mode: 0o644 },
            offset: 0,
            body: new ReadableStream<Uint8Array>({
              pull(controller) {
                pulled += 1;
                controller.enqueue(line);
                if (pulled === lines) controller.close();
              },
              cancel() {
                cancelled = true;
              },
            }),
          };
        },
      }),
    );

    expect(await ws.fs.grep("care", `${ROOT}/README.md`, { limit: 2 })).toHaveLength(2);
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("reads nothing at or past the end of a file a mount can't seek in", async () => {
    let pulled = 0;
    let cancelled = false;
    const ws = open(
      fakePassthrough(FILES, {
        readFile: async () => ({
          stat: { type: "file", size: 6, mtime: 0, mode: 0o644 },
          offset: 0,
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new TextEncoder().encode("abcdef"));
              controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
        }),
      }),
    );
    expect(await ws.fs.readFile(`${ROOT}/README.md`, { encoding: "utf8", byteOffset: 6 })).toBe("");
    expect(await ws.fs.readFile(`${ROOT}/README.md`, { encoding: "utf8", byteOffset: 60 })).toBe(
      "",
    );
    expect(pulled).toBeLessThanOrEqual(2);
    expect(cancelled).toBe(true);
  });

  it("leaves a broken mount out of walks above it and fails walks inside it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const broken = fakePassthrough(FILES, {
        readdir: async () => {
          throw new Error("upstream down");
        },
      });
      const ws = new Workspace({
        storage: new SQLiteTestStorage(),
        mounts: { [ROOT]: fakePassthrough(FILES), "/skills/broken": broken },
      });

      const found = (await ws.fs.find("/")).map((entry) => entry.path);
      expect(found).toContain(`${ROOT}/pdf/SKILL.md`);
      expect(found.some((path) => path.startsWith("/skills/broken"))).toBe(false);
      expect(await ws.fs.ls("/skills")).toContain(`${ROOT}/README.md`);
      expect((await ws.fs.grep("care", "/")).map((match) => match.path)).toEqual([
        `${ROOT}/pdf/SKILL.md`,
      ]);
      expect((await ws.fs.readdir("/skills")).map((entry) => entry.name)).toEqual([
        "broken",
        "team",
      ]);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ root: "/skills/broken" }));

      await expect(ws.fs.find("/skills/broken")).rejects.toMatchObject({ code: "EIO" });
      await expect(ws.fs.grep("care", "/skills/broken")).rejects.toMatchObject({ code: "EIO" });
      await expect(ws.fs.ls("/skills/broken")).rejects.toMatchObject({ code: "EIO" });
    } finally {
      warn.mockRestore();
    }
  });

  it("merges roots at several depths in find's order", async () => {
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      mounts: {
        "/top": fakePassthrough({ "t.md": "t" }),
        "/a/b/c/deep": fakePassthrough({ "d.md": "d", "sub/e.md": "e" }),
        [ROOT]: fakePassthrough({ "s.md": "s" }),
      },
    });
    await ws.fs.writeFile("/a/b/x.md", "x");
    await ws.fs.writeFile("/a/b/c/z.md", "z");
    await ws.fs.writeFile("/m.md", "m");

    expect((await ws.fs.find("/")).map((entry) => entry.path)).toEqual([
      "/a",
      "/a/b",
      "/a/b/c",
      "/a/b/c/deep",
      "/a/b/c/deep/d.md",
      "/a/b/c/deep/sub",
      "/a/b/c/deep/sub/e.md",
      "/a/b/c/z.md",
      "/a/b/x.md",
      "/m.md",
      "/skills",
      ROOT,
      `${ROOT}/s.md`,
      "/top",
      "/top/t.md",
    ]);
    expect(await ws.fs.find("/", "**/*.md", { offset: 2, limit: 3 })).toEqual([
      { path: "/a/b/c/z.md", type: "file" },
      { path: "/a/b/x.md", type: "file" },
      { path: "/m.md", type: "file" },
    ]);
    expect(await ws.fs.ls("/a")).toEqual([
      "/a/b/c/deep/d.md",
      "/a/b/c/deep/sub/e.md",
      "/a/b/c/z.md",
      "/a/b/x.md",
    ]);
    expect((await ws.fs.readdir("/")).map((entry) => entry.name)).toEqual([
      "a",
      "m.md",
      "skills",
      "top",
    ]);
  });

  it("lists a root's parent asynchronously, and refuses to synchronously", async () => {
    const ws = open(fakePassthrough(FILES));
    const provider = ws.provider();
    expect(() => provider.readdirSync("/skills")).toThrow(
      expect.objectContaining({ code: "ENOTSUP" }),
    );
    expect(() => provider.readdirEntriesSync("/skills")).toThrow(
      expect.objectContaining({ code: "ENOTSUP" }),
    );
    const dirents = (await provider.readdir("/skills", { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
    }>;
    expect(dirents.map((entry) => [entry.name, entry.isDirectory()])).toEqual([["team", true]]);
    // A directory that lists no root still lists synchronously.
    await ws.fs.mkdir("/other");
    expect(provider.readdirSync("/other")).toEqual([]);
  });

  it("rebuilds a mount's WorkspaceFsError with a cut message and the path asked for", async () => {
    const ws = open(
      fakePassthrough(FILES, {
        stat: async () => {
          throw createWorkspaceError("EACCES", `denied ${"x".repeat(5_000)}`, "relative/elsewhere");
        },
      }),
    );
    const error = await ws.fs.stat(`${ROOT}/secret.md`).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "EACCES", path: `${ROOT}/secret.md` });
    expect((error as Error).message.length).toBeLessThan(1_200);
    expect((error as Error).message).toMatch(/^denied x+…/);
  });
});
