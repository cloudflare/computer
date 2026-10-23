import {
  decodeFiles,
  encodeFiles,
  FILE_TRANSFER_ROUTES,
  type FileConflict,
  type FileManifestEntry,
  FileTransferConflictError,
} from "@cloudflare/computer-rpc/files";
import { compileGlob, Database, initializeSchema, WorkspaceFilesystem } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BackendHandle } from "../../backend.js";
import { ContainerBackend } from "../container/container-backend.js";
import type { ContainerRuntimeInfo, IWorkspaceContainerAPI } from "../container/container-host.js";
import type { ContainerLaunchSpec } from "../container/container-launch-record.js";
import { pullFiles, pushFiles, type TransferFetch } from "./file-transfer.js";
import { SimpleContainerBackend } from "./simple-container-backend.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface DiskFile {
  bytes: Uint8Array;
  mtime: number;
  mode: number;
}

// computerd's file transfer routes over an in-memory disk, speaking the
// real wire format, with the same rules for what to send: a manifest of
// what last matched the Workspace, by revision and content, decides.
function fakeComputerd() {
  const disk = new Map<string, DiskFile>();
  const manifest = new Map<string, { rev: number; content: string }>();
  const sent = new Map<string, string>();
  const requests: string[] = [];
  const text = (file: DiskFile) => decoder.decode(file.bytes);
  const fetch: TransferFetch = async (path, init) => {
    requests.push(path);
    if (path === FILE_TRANSFER_ROUTES.diff) {
      const { files } = JSON.parse(String(init.body)) as { files: FileManifestEntry[] };
      const want = files
        .filter((entry) => {
          const held = disk.get(entry.path);
          if (held === undefined) return true;
          const recorded = manifest.get(entry.path);
          if (recorded !== undefined && entry.rev !== undefined) return recorded.rev !== entry.rev;
          return held.bytes.length !== entry.size || held.mtime !== entry.mtime;
        })
        .map((entry) => entry.path);
      return Response.json({ want });
    }
    if (path === FILE_TRANSFER_ROUTES.put) {
      let written = 0;
      let bytes = 0;
      for await (const file of decodeFiles(init.body as ReadableStream<Uint8Array>)) {
        const content = new Uint8Array(await new Response(file.body).arrayBuffer());
        const stored = { bytes: content, mtime: file.header.mtime, mode: file.header.mode };
        disk.set(file.header.path, stored);
        if (file.header.rev === undefined) manifest.delete(file.header.path);
        else manifest.set(file.header.path, { rev: file.header.rev, content: text(stored) });
        written += 1;
        bytes += content.length;
      }
      return Response.json({ written, bytes });
    }
    if (path === FILE_TRANSFER_ROUTES.pull) {
      const request = JSON.parse(String(init.body)) as {
        patterns: string[];
        exclude: string[];
        have: FileManifestEntry[];
        force: boolean;
      };
      const includes = request.patterns.map((glob) => compileGlob(glob));
      const excludes = request.exclude.map((glob) => compileGlob(glob));
      const have = new Map(request.have.map((entry) => [entry.path, entry]));
      const conflicts: FileConflict[] = [];
      const out = [...disk]
        .filter(([name]) => includes.some((regex) => regex.test(name)))
        .filter(([name]) => !excludes.some((regex) => regex.test(name)))
        .filter(([name, file]) => {
          if (request.force) return true;
          const known = have.get(name);
          const recorded = manifest.get(name);
          if (recorded !== undefined) {
            if (recorded.content === text(file)) return false;
            if (known?.rev !== undefined && known.rev > recorded.rev) {
              conflicts.push({
                path: name,
                reason: "modified",
                localRev: known.rev,
                baseRev: recorded.rev,
              });
              return false;
            }
            return true;
          }
          if (known === undefined) return true;
          if (known.size === file.bytes.length && file.mtime <= known.mtime) return false;
          if (known.rev !== undefined) {
            conflicts.push({ path: name, reason: "untracked", localRev: known.rev });
            return false;
          }
          return true;
        });
      if (conflicts.length > 0) return Response.json({ conflicts }, { status: 409 });
      for (const [name, file] of out) sent.set(name, text(file));
      return new Response(
        encodeFiles(
          out.map(([name, file]) => ({
            header: { path: name, size: file.bytes.length, mtime: file.mtime, mode: file.mode },
            body: async () => file.bytes,
          })),
        ),
      );
    }
    if (path === FILE_TRANSFER_ROUTES.record) {
      const { files } = JSON.parse(String(init.body)) as {
        files: Array<{ path: string; rev: number }>;
      };
      let recorded = 0;
      for (const { path: name, rev } of files) {
        const content = sent.get(name);
        if (content === undefined) continue;
        sent.delete(name);
        manifest.set(name, { rev, content });
        recorded += 1;
      }
      return Response.json({ recorded });
    }
    return new Response("not found\n", { status: 404 });
  };
  const write = (path: string, text: string, mtime: number, mode = 0o644) =>
    disk.set(path, { bytes: encoder.encode(text), mtime, mode });
  const read = (path: string) => {
    const file = disk.get(path);
    return file === undefined ? undefined : decoder.decode(file.bytes);
  };
  return { fetch, disk, manifest, requests, write, read };
}

function workspaceFS() {
  let now = 1_000_000;
  const db = new Database(new SQLiteTestStorage());
  initializeSchema(db, () => 0);
  const fs = new WorkspaceFilesystem(db, { now: () => now });
  return {
    fs,
    setNow: (value: number) => {
      now = value;
    },
    async write(path: string, text: string) {
      await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await fs.writeFile(path, text);
    },
  };
}

describe("pushFiles", () => {
  it("sends matching files, then only what changed", async () => {
    const workspace = workspaceFS();
    const container = fakeComputerd();
    await workspace.write("/workspace/package.json", "{}");
    await workspace.write("/workspace/src/index.js", "index");
    await workspace.write("/workspace/src/lib/util.js", "util");
    await workspace.write("/workspace/src/readme.md", "readme");
    await workspace.write("/workspace/other/x.js", "other");

    const first = await pushFiles(workspace.fs, container.fetch, "/workspace", [
      "package.json",
      "src/**/*.js",
    ]);
    expect(first).toEqual({ pushed: 3, unchanged: 0, bytes: 11 });
    expect([...container.disk.keys()].sort()).toEqual([
      "package.json",
      "src/index.js",
      "src/lib/util.js",
    ]);

    // Unchanged: the manifest goes over, no bytes do.
    container.requests.length = 0;
    const second = await pushFiles(workspace.fs, container.fetch, "/workspace", ["src"]);
    expect(second).toEqual({ pushed: 1, unchanged: 2, bytes: 6 });
    expect(container.read("src/readme.md")).toBe("readme");

    container.requests.length = 0;
    workspace.setNow(2_000_000);
    await workspace.fs.writeFile("/workspace/src/index.js", "changed");
    const third = await pushFiles(workspace.fs, container.fetch, "/workspace", ["src"]);
    expect(third).toEqual({ pushed: 1, unchanged: 2, bytes: 7 });
    expect(container.read("src/index.js")).toBe("changed");
    expect(container.disk.get("src/index.js")?.mtime).toBe(2_000_000);
    expect(container.requests).toEqual([FILE_TRANSFER_ROUTES.diff, FILE_TRANSFER_ROUTES.put]);
  });

  it("skips the PUT when nothing changed, and sends everything with force", async () => {
    const workspace = workspaceFS();
    const container = fakeComputerd();
    await workspace.write("/workspace/a.txt", "a");
    await pushFiles(workspace.fs, container.fetch, "/workspace", ["a.txt"]);

    container.requests.length = 0;
    expect(await pushFiles(workspace.fs, container.fetch, "/workspace", ["a.txt"])).toEqual({
      pushed: 0,
      unchanged: 1,
      bytes: 0,
    });
    expect(container.requests).toEqual([FILE_TRANSFER_ROUTES.diff]);

    container.requests.length = 0;
    const forced = await pushFiles(workspace.fs, container.fetch, "/workspace", ["a.txt"], {
      force: true,
    });
    expect(forced).toEqual({ pushed: 1, unchanged: 0, bytes: 1 });
    expect(container.requests).toEqual([FILE_TRANSFER_ROUTES.put]);
  });

  it("leaves out excluded directories at any depth, and missing paths", async () => {
    const workspace = workspaceFS();
    const container = fakeComputerd();
    await workspace.write("/workspace/src/a.js", "a");
    await workspace.write("/workspace/src/vendor/b.js", "b");
    await workspace.write("/workspace/node_modules/c.js", "c");

    const result = await pushFiles(
      workspace.fs,
      container.fetch,
      "/workspace",
      ["**/*.js", "does/not/exist"],
      { exclude: ["node_modules", "**/vendor"] },
    );
    expect(result.pushed).toBe(1);
    expect([...container.disk.keys()]).toEqual(["src/a.js"]);
  });

  it("refuses patterns outside the root", async () => {
    const workspace = workspaceFS();
    const container = fakeComputerd();
    await expect(
      pushFiles(workspace.fs, container.fetch, "/workspace", ["/etc/passwd"]),
    ).rejects.toThrow(/outside \/workspace/);
    await expect(pushFiles(workspace.fs, container.fetch, "/workspace", ["../x"])).rejects.toThrow(
      /\.\./,
    );
  });

  it("says plainly when the container's computerd predates file transfer", async () => {
    const workspace = workspaceFS();
    await workspace.write("/workspace/a.txt", "a");
    const old: TransferFetch = async () => new Response("not found\n", { status: 404 });
    await expect(pushFiles(workspace.fs, old, "/workspace", ["a.txt"])).rejects.toThrow(
      /does not serve file transfer/,
    );
  });
});

describe("pullFiles", () => {
  it("writes container files into the Workspace with their mode", async () => {
    const workspace = workspaceFS();
    const container = fakeComputerd();
    container.write("dist/out.js", "out", 500);
    container.write("dist/bin/run", "#!/bin/sh", 500, 0o755);
    container.write("src/ignored.js", "nope", 500);

    const result = await pullFiles(workspace.fs, container.fetch, "/workspace", ["./dist"]);
    expect(result).toEqual({ pulled: 2, bytes: 12, skipped: [] });
    expect(await workspace.fs.readFile("/workspace/dist/out.js", "utf8")).toBe("out");
    expect((await workspace.fs.stat("/workspace/dist/bin/run")).mode & 0o777).toBe(0o755);
    await expect(workspace.fs.stat("/workspace/src/ignored.js")).rejects.toThrow(/ENOENT|no such/);
  });

  it("does not fetch files again until the container changes them", async () => {
    const workspace = workspaceFS();
    const container = fakeComputerd();
    container.write("dist/out.js", "out", 500);
    await pullFiles(workspace.fs, container.fetch, "/workspace", ["dist"]);

    // The Workspace copy was written at 1_000_000, after the container's.
    expect(await pullFiles(workspace.fs, container.fetch, "/workspace", ["dist"])).toEqual({
      pulled: 0,
      bytes: 0,
      skipped: [],
    });

    container.write("dist/out.js", "new", 1_500_000);
    const changed = await pullFiles(workspace.fs, container.fetch, "/workspace", ["dist"]);
    expect(changed.pulled).toBe(1);
    expect(await workspace.fs.readFile("/workspace/dist/out.js", "utf8")).toBe("new");

    const forced = await pullFiles(workspace.fs, container.fetch, "/workspace", ["dist"], {
      force: true,
    });
    expect(forced.pulled).toBe(1);
  });

  it("round-trips with push: pushed files are not pulled back", async () => {
    const workspace = workspaceFS();
    const container = fakeComputerd();
    await workspace.write("/workspace/src/a.js", "a");
    await pushFiles(workspace.fs, container.fetch, "/workspace", ["src"]);
    container.write("src/generated.js", "gen", 1_200_000);

    const result = await pullFiles(workspace.fs, container.fetch, "/workspace", ["src"]);
    expect(result.pulled).toBe(1);
    expect(await workspace.fs.readFile("/workspace/src/generated.js", "utf8")).toBe("gen");
  });

  it("records the revision each pulled file was written at", async () => {
    const workspace = workspaceFS();
    const container = fakeComputerd();
    container.write("dist/out.js", "out", 500);
    await pullFiles(workspace.fs, container.fetch, "/workspace", ["dist"]);
    expect(container.manifest.get("dist/out.js")).toEqual({
      rev: await workspace.fs.revision("/workspace/dist/out.js"),
      content: "out",
    });
    expect(container.requests.at(-1)).toBe(FILE_TRANSFER_ROUTES.record);
  });

  it("refuses to overwrite a file the Workspace changed since the push, unless forced", async () => {
    const workspace = workspaceFS();
    const container = fakeComputerd();
    await workspace.write("/workspace/src/a.js", "original");
    await workspace.write("/workspace/src/b.js", "b");
    await pushFiles(workspace.fs, container.fetch, "/workspace", ["src"]);

    // Both sides edit a.js; only the container edits b.js.
    await workspace.fs.writeFile("/workspace/src/a.js", "workspace edit");
    container.write("src/a.js", "container edit", 2_000_000);
    container.write("src/b.js", "container b", 2_000_000);

    const refused = pullFiles(workspace.fs, container.fetch, "/workspace", ["src"]);
    await expect(refused).rejects.toBeInstanceOf(FileTransferConflictError);
    await expect(refused).rejects.toMatchObject({
      conflicts: [{ path: "/workspace/src/a.js", reason: "modified" }],
    });
    // Refused as a whole: b.js, which had no conflict, was not written either.
    expect(await workspace.fs.readFile("/workspace/src/a.js", "utf8")).toBe("workspace edit");
    expect(await workspace.fs.readFile("/workspace/src/b.js", "utf8")).toBe("b");

    const forced = await pullFiles(workspace.fs, container.fetch, "/workspace", ["src"], {
      force: true,
    });
    expect(forced.pulled).toBe(2);
    expect(await workspace.fs.readFile("/workspace/src/a.js", "utf8")).toBe("container edit");
  });

  it("does not call it a conflict when only the Workspace changed", async () => {
    const workspace = workspaceFS();
    const container = fakeComputerd();
    await workspace.write("/workspace/src/a.js", "original");
    await pushFiles(workspace.fs, container.fetch, "/workspace", ["src"]);
    await workspace.fs.writeFile("/workspace/src/a.js", "workspace edit");

    expect(await pullFiles(workspace.fs, container.fetch, "/workspace", ["src"])).toEqual({
      pulled: 0,
      bytes: 0,
      skipped: [],
    });
    expect(await workspace.fs.readFile("/workspace/src/a.js", "utf8")).toBe("workspace edit");
  });

  it("fails on a transfer the container cut short", async () => {
    const workspace = workspaceFS();
    const full = await new Response(
      encodeFiles([
        {
          header: { path: "a.txt", size: 100, mtime: 0, mode: 0o644 },
          body: async () => new Uint8Array(100),
        },
      ]),
    ).arrayBuffer();
    const cut: TransferFetch = async () => new Response(full.slice(0, 60));
    await expect(pullFiles(workspace.fs, cut, "/workspace", ["**"])).rejects.toThrow(/ended early/);
  });
});

function recordingHost() {
  const specs: ContainerLaunchSpec[] = [];
  const info: ContainerRuntimeInfo = {
    runtimeId: "runtime-1",
    clientSecret: "00112233445566778899aabbccddeeff",
    outcome: "launched",
  };
  const host: IWorkspaceContainerAPI = {
    async start(spec) {
      specs.push(spec);
      return info;
    },
    async restart(spec) {
      specs.push(spec);
      return info;
    },
    async interceptOutboundHttp() {},
    async interceptAllOutboundHttp() {},
    // Never healthy: connect() fails once it has launched, which is all
    // these tests need to see.
    async fetchPort() {
      return new Response(null, { status: 503 });
    },
    port() {
      throw new Error("not used");
    },
    async setInactivityTimeout() {},
    async status() {
      return { running: true, exit: null };
    },
    async exitInfo() {
      return null;
    },
  };
  return { host, specs };
}

describe("SimpleContainerBackend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function backend(options: Partial<ConstructorParameters<typeof SimpleContainerBackend>[0]> = {}) {
    const { host, specs } = recordingHost();
    const simple = new SimpleContainerBackend({
      container: () => ({ getWorkspaceContainer: () => host }),
      workspace: { binding: "SESSIONS", id: "session-1" },
      restartAttempts: 0,
      connectTimeoutMs: 200,
      healthProbeTimeoutMs: 20,
      healthRetryInitialDelayMs: 5,
      healthRetryMaxDelayMs: 10,
      heartbeatIntervalMs: 0,
      ...options,
    });
    return { simple, specs };
  }

  it("launches computerd with no mount and no mount point", async () => {
    const { simple, specs } = backend({
      // A caller cannot put the mount, or a mount point, back.
      containerEnv: {
        FUSE_MOUNT: "fuse",
        MOUNT_POINT: "/srv",
        MOUNT_IGNORE: "**/node_modules",
        EXTRA: "1",
      },
    });
    await simple.connect().catch(() => undefined);
    expect(specs[0]?.env).toEqual({ PORT: "8080", FUSE_MOUNT: "none", EXTRA: "1" });
    expect(simple.id).toBe("container-shell");
    expect(simple.type).toBe("simple-container");
    expect(simple.description).toMatch(/push\(\).*pull\(\)/);
  });

  it("hands the Workspace a handle that declares no sync", async () => {
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const handle = { rpc: {}, runtimeId: "runtime-1", close } as unknown as BackendHandle;
    vi.spyOn(ContainerBackend.prototype, "connect").mockResolvedValue(handle);
    const { simple } = backend();
    const connected = await simple.connect();
    expect(connected.sync).toBe("none");
    expect(connected.runtimeId).toBe("runtime-1");
    await connected.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("pushes and pulls through computerd with paths relative to the root", async () => {
    const container = fakeComputerd();
    const calls: string[] = [];
    vi.spyOn(ContainerBackend.prototype, "fetchComputerd").mockImplementation(
      async (path, init) => {
        calls.push(path);
        return container.fetch(path, init ?? {});
      },
    );
    const workspace = workspaceFS();
    await workspace.write("/workspace/src/a.js", "a");
    const { simple } = backend();

    // The same file on both sides, named relative to "/" on the wire.
    expect(await simple.push(workspace.fs, ["/workspace/src"])).toEqual({
      pushed: 1,
      unchanged: 0,
      bytes: 1,
    });
    expect(container.read("workspace/src/a.js")).toBe("a");

    // A relative pattern is taken from the root too.
    container.write("workspace/dist/out.js", "out", 1);
    const pulled = await simple.pull(workspace.fs, ["workspace/dist"]);
    expect(pulled.pulled).toBe(1);
    expect(await workspace.fs.readFile("/workspace/dist/out.js", "utf8")).toBe("out");
    expect(calls).toEqual([
      FILE_TRANSFER_ROUTES.diff,
      FILE_TRANSFER_ROUTES.put,
      FILE_TRANSFER_ROUTES.pull,
      FILE_TRANSFER_ROUTES.record,
    ]);
  });
});
