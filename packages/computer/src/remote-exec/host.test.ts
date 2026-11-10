/**
 * The host side (exec.ts, sync.ts, session.ts) against a scripted session: what a compromised or
 * crashing remote-exec can do to the Durable Object, and what the host sends it.
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecSyncError, remoteExec, type RemoteExecConfig } from "./exec";
import { ProtocolError } from "./messages";
import { RemoteExecError } from "./session";
import {
  expectRequest,
  FakeSessionTarget,
  openNormally,
  type SessionScript,
} from "./testing/fake-session";
import { tree, write } from "./testing/harness";
import { directoryFs } from "./testing/local";

let ws: string;
beforeEach(async () => {
  ws = await fsp.mkdtemp(path.join(os.tmpdir(), "remote-exec-host-"));
});
afterEach(async () => {
  await fsp.rm(ws, { recursive: true, force: true });
});

function config(
  target: FakeSessionTarget,
  extra: Partial<RemoteExecConfig> = {},
): RemoteExecConfig {
  return {
    target,
    fs: directoryFs(ws),
    workspaceRoot: "/workspace",
    containerRoot: "/ctr",
    agentPath: "/bin/remote-exec",
    id: "xtest",
    ...extra,
  };
}

const bytes = (s: string) => new TextEncoder().encode(s);
const sha = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(s)));
const fileEntry = async (p: string, content: string, mode = 0o644) => ({
  path: p,
  kind: "file",
  mode,
  size: content.length,
  hash: await sha(content),
  target: "",
});

/** Open normally, then answer the pull with `pull`, then close. */
function pulling(pull: (s: SessionScript) => Promise<void>, want?: (n: number) => number[]) {
  return async (s: SessionScript) => {
    await openNormally(s, want);
    await expectRequest(s, "pull");
    await pull(s);
    const close = await s.next();
    if (close?.type === "close") await s.send({ type: "closed" });
  };
}

describe("what the host sends", () => {
  it("drives the whole exchange in order, with mapped cwd, globs, env, user and lock", async () => {
    await write(ws, { "app/src/a.txt": "A" });
    const target = new FakeSessionTarget(
      pulling(
        async (s) => {
          await s.send({ type: "changes", changed: [], deleted: [], skipped: [] });
          await s.send({
            type: "pullEnd",
            report: { written: 0, bytes: 0, deleted: [], skipped: [] },
          });
        },
        () => [0],
      ),
      { stdout: "out", exitCode: 4 },
    );
    const proc = await remoteExec(config(target), ["make", "test"], {
      push: ["src/**"],
      pull: ["out/**"],
      cwd: "/workspace/app",
      env: { CI: "1" },
      user: "1000:1000",
    });
    expect(proc.pid).toBe(1234);
    expect(await new Response(proc.stdout).text()).toBe("out");
    expect(await proc.exitCode).toBe(4);
    expect(target.requests.map((r) => r.type)).toEqual([
      "begin",
      "push",
      "chunk",
      "pushEnd",
      "prepare",
      "awaitStart",
      "pull",
      "close",
    ]);
    expect(target.requests[0]).toMatchObject({
      type: "begin",
      id: "xtest",
      root: "/ctr",
      lock: true,
    });
    expect(target.requests[1]).toMatchObject({
      type: "push",
      selection: { root: "/ctr", globs: ["app/src/**"] },
      owner: "1000:1000",
      manifest: [{ path: "app/src/a.txt", kind: "file", size: 1 }],
    });
    expect(target.requests[2]).toMatchObject({
      type: "chunk",
      index: 0,
      data: bytes("A"),
      last: true,
    });
    expect(target.requests[4]).toEqual({
      type: "prepare",
      spec: { argv: ["make", "test"], cwd: "/ctr/app", env: { CI: "1" }, user: "1000:1000" },
      pull: { root: "/ctr", globs: ["app/out/**"] },
    });
    expect(target.commands[1]).toEqual([
      "/bin/remote-exec",
      "run",
      "--session",
      "xtest",
      "--token",
      "07".repeat(16),
    ]);
  });

  it("aborts the session when the command's exit code can't be read, freeing its lock", async () => {
    const target = new FakeSessionTarget(
      async (s) => {
        await openNormally(s);
        // An abort, not a close: the session's input just ends.
        expect(await s.next()).toBeUndefined();
      },
      { exitError: new Error("connection lost") },
    );
    const proc = await remoteExec(config(target), ["make"], { pull: ["*"] });
    await expect(proc.exitCode).rejects.toThrow("connection lost");
    await expect(proc.pulled).rejects.toThrow("connection lost");
    await target.sessionDone;
    expect(target.stdinClosed).toBe(true);
  });

  it("doesn't lock, push or pull when nothing is synced", async () => {
    const target = new FakeSessionTarget(async (s) => {
      await openNormally(s);
      if ((await s.next())?.type === "close") await s.send({ type: "closed" });
    });
    const proc = await remoteExec(config(target), ["true"]);
    expect(await proc.exitCode).toBe(0);
    expect((await proc.pulled).status).toBe("skipped");
    expect(target.requests.map((r) => r.type)).toEqual(["begin", "prepare", "awaitStart", "close"]);
    expect(target.requests[0]).toMatchObject({ lock: false });
    expect(target.requests[1]).toMatchObject({ spec: { cwd: "/ctr" } });
  });

  it("maps cwd under the workspace and leaves other paths alone", async () => {
    for (const [cwd, expected] of [
      ["/workspace", "/ctr"],
      ["/workspace/a/b", "/ctr/a/b"],
      ["/tmp", "/tmp"],
      ["/workspacex", "/workspacex"],
    ]) {
      const target = new FakeSessionTarget(async (s) => {
        await openNormally(s);
        await s.next();
      });
      await (
        await remoteExec(config(target), ["true"], { cwd })
      ).exitCode;
      expect(
        target.requests.find((r) => r.type === "prepare"),
        cwd,
      ).toMatchObject({ spec: { cwd: expected } });
    }
  });

  it("sends files in 1 MiB chunks, an empty file as one empty last chunk", async () => {
    await write(ws, { "big.bin": "x".repeat(2.5 * 1024 * 1024), empty: "" });
    const target = new FakeSessionTarget(async (s) => {
      await openNormally(s, (n) => Array.from({ length: n }, (_, i) => i));
      await s.next();
    });
    await (
      await remoteExec(config(target), ["true"], { push: ["*"] })
    ).exitCode;
    const chunks = target.requests.filter((r) => r.type === "chunk");
    expect(chunks.map((c) => [c.index, c.data.byteLength, c.last])).toEqual([
      [0, 1048576, false],
      [0, 1048576, false],
      [0, 524288, true],
      [1, 0, true],
    ]);
  });

  it("leaves files over the limits out of the manifest and reports them", async () => {
    await write(ws, { "a.txt": "aaaa", "b.txt": "bb", "c.txt": "c", "d.txt": "d" });
    const target = new FakeSessionTarget(async (s) => {
      await openNormally(s);
      await s.next();
    });
    const proc = await remoteExec(
      config(target, { limits: { maxFileBytes: 3, maxSyncFiles: 2 } }),
      ["true"],
      { push: ["*"] },
    );
    await proc.exitCode;
    const push = target.requests.find((r) => r.type === "push");
    expect(push?.type === "push" && push.manifest.map((e) => e.path)).toEqual(["b.txt", "c.txt"]);
    expect(proc.pushed.skipped).toEqual([
      { path: "a.txt", reason: "too-large" },
      { path: "d.txt", reason: "too-many-files" },
    ]);
  });

  it("tells the session which selected files it left out, so it keeps them", async () => {
    await write(ws, { "big.bin": "0123456789", "a.txt": "a" });
    const target = new FakeSessionTarget(async (s) => {
      await openNormally(s);
      await s.next();
    });
    const proc = await remoteExec(config(target, { limits: { maxFileBytes: 5 } }), ["true"], {
      push: ["*"],
    });
    await proc.exitCode;
    const push = target.requests.find((r) => r.type === "push");
    expect(push?.type === "push" && push.manifest.map((e) => e.path)).toEqual(["a.txt"]);
    expect(push?.type === "push" && push.keep).toEqual(["big.bin"]);
  });

  for (const during of ["begin", "push", "prepare"] as const) {
    it(`an abort while the session answers ${during} ends it and never starts the command`, async () => {
      await write(ws, { "a.txt": "a" });
      const controller = new AbortController();
      const target = new FakeSessionTarget(async (s) => {
        for (;;) {
          const r = await s.next();
          if (r === undefined) return; // the host closed stdin: aborted
          if (r.type === during) {
            // Waiting for the lock, mid-push, preparing: the caller gives up.
            controller.abort();
            await s.next();
            return;
          }
          if (r.type === "begin")
            await s.send({
              type: "begun",
              protocol: 1,
              version: "f",
              arch: "x86_64",
              lockWaitMs: 0,
            });
          else if (r.type === "push") await s.send({ type: "want", indices: [] });
          else if (r.type === "pushEnd")
            await s.send({
              type: "pushReport",
              report: { written: 0, bytes: 0, deleted: [], skipped: [] },
            });
        }
      });
      await expect(
        remoteExec(config(target), ["touch", "ran"], { push: ["**"], signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      await target.sessionDone;
      expect(target.stdinClosed).toBe(true);
      expect(target.commands.some((c) => c[1] === "run")).toBe(false);
      expect(target.requests.some((r) => r.type === "awaitStart")).toBe(false);
    });
  }

  it("kill() signals through the session; abort SIGKILLs and skips pull", async () => {
    let release!: () => void;
    const exited = new Promise<number>((r) => (release = () => r(137)));
    const target = new FakeSessionTarget(async (s) => {
      await openNormally(s);
      for (;;) {
        const r = await s.next();
        if (r === undefined) return;
        if (r.type === "signal") {
          await s.send({ type: "signaled" });
          if (r.signal === 9) release();
        }
        if (r.type === "close") return s.send({ type: "closed" });
      }
    });
    const runExit = { exitCode: 0 };
    target.exec = ((original) => async (cmd, options) => {
      const p = await original(cmd, options);
      return cmd[1] === "run" ? { ...p, exitCode: exited } : p;
    })(target.exec.bind(target));
    void runExit;
    const controller = new AbortController();
    const proc = await remoteExec(config(target), ["sleep", "100"], {
      pull: ["**"],
      signal: controller.signal,
    });
    proc.kill(2);
    expect(() => proc.kill(0)).toThrow(RangeError);
    expect(() => proc.kill(65)).toThrow(RangeError);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect(await proc.exitCode).toBe(137);
    expect((await proc.pulled).status).toBe("skipped");
    expect(target.requests.filter((r) => r.type === "signal")).toEqual([
      { type: "signal", signal: 2 },
      { type: "signal", signal: 9 },
    ]);
    expect(target.requests.some((r) => r.type === "pull")).toBe(false);
  });
});

describe("validating the call before anything starts", () => {
  it("refuses bad argv, users, globs and an already-aborted signal", async () => {
    const target = new FakeSessionTarget(async () => undefined);
    const run = (argv: unknown, options = {}) =>
      remoteExec(config(target), argv as string[], options);
    await expect(run([])).rejects.toThrow(TypeError);
    await expect(run("ls")).rejects.toThrow(TypeError);
    await expect(run(["ls", 1])).rejects.toThrow(TypeError);
    await expect(run(["ls"], { user: "root" })).rejects.toThrow(/numeric/);
    await expect(run(["ls"], { push: ["../x"] })).rejects.toThrow(TypeError);
    await expect(run(["ls"], { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(target.commands).toEqual([]);
  });
});

describe("a session that misbehaves", () => {
  it("an error reply rejects exec() with its code, and the session is closed", async () => {
    const target = new FakeSessionTarget(async (s) => {
      await s.next();
      await s.send({
        type: "error",
        code: "busy",
        message: "another call holds the lock",
        errno: 0,
      });
      await s.next(); // the host closes stdin
    });
    await expect(remoteExec(config(target), ["true"], { push: ["**"] })).rejects.toMatchObject({
      name: "RemoteExecError",
      code: "busy",
    });
    await target.sessionDone;
    expect(target.stdinClosed).toBe(true);
  });

  it("a session that dies before answering rejects with its last log lines", async () => {
    const target = new FakeSessionTarget(async (s) => {
      await s.next();
      await s.end();
    });
    await expect(remoteExec(config(target), ["true"])).rejects.toThrow(
      /ended unexpectedly[\s\S]*scripted session/,
    );
  });

  it("garbage and the wrong reply are protocol errors", async () => {
    const garbage = new FakeSessionTarget(async (s) => {
      await s.next();
      await s.sendRaw(
        new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef]),
      );
      await s.next();
    });
    await expect(remoteExec(config(garbage), ["true"])).rejects.toThrow(ProtocolError);
    const wrong = new FakeSessionTarget(async (s) => {
      await s.next();
      await s.send({ type: "started", pid: 1 });
      await s.next();
    });
    await expect(remoteExec(config(wrong), ["true"])).rejects.toThrow(
      /expected begun, got started/,
    );
  });

  it("wanting a file that isn't in the manifest is a protocol error", async () => {
    await write(ws, { "a.txt": "a" });
    const target = new FakeSessionTarget(async (s) => {
      await openNormally(s, () => [5]);
      await s.next();
    });
    await expect(remoteExec(config(target), ["true"], { push: ["**"] })).rejects.toThrow(
      /entry 5, which doesn't exist/,
    );
  });

  it("a spawn failure rejects exec() like the platform, with the errno", async () => {
    const target = new FakeSessionTarget(async (s) => {
      for (;;) {
        const r = await s.next();
        if (r?.type === "begin")
          await s.send({ type: "begun", protocol: 1, version: "", arch: "", lockWaitMs: 0 });
        if (r?.type === "prepare") await s.send({ type: "prepared", token: new Uint8Array(16) });
        if (r?.type === "awaitStart")
          return s.send({ type: "error", code: "spawn", message: "nope: No such file", errno: 2 });
      }
    });
    await expect(remoteExec(config(target), ["nope"])).rejects.toMatchObject({
      code: "spawn",
      errno: 2,
      message: "exec: nope: No such file",
    });
  });
});

describe("pull against a misbehaving session", () => {
  const changes = (changed: unknown[], deleted: string[] = []) => ({
    type: "changes",
    changed,
    deleted,
    skipped: [],
  });
  const end = { type: "pullEnd", report: { written: 0, bytes: 0, deleted: [], skipped: [] } };

  it("fails the pull, rather than hanging, when the workspace can't write a file", async () => {
    const target = new FakeSessionTarget(
      pulling(async (s) => {
        await s.send(changes([await fileEntry("out/new.txt", "fresh")], []));
        await s.send({ type: "chunk", index: 0, data: bytes("fresh"), last: true });
        await s.send(end);
      }),
    );
    const fs = { ...directoryFs(ws), writeFile: () => Promise.reject(new Error("disk full")) };
    const proc = await remoteExec(config(target, { fs }), ["x"], { pull: ["**"] });
    await expect(proc.pulled).rejects.toThrow(/disk full/);
    await expect(proc.exitCode).rejects.toThrow(/pull failed: disk full/);
  });

  it("writes changed files, links and deletions into the workspace", async () => {
    await write(ws, { "gone.txt": "bye", "keep.txt": "same" });
    const target = new FakeSessionTarget(
      pulling(async (s) => {
        await s.send(
          changes(
            [
              await fileEntry("out/new.txt", "fresh", 0o755),
              {
                path: "out/link",
                kind: "symlink",
                mode: 0o777,
                size: 0,
                hash: new Uint8Array(),
                target: "new.txt",
              },
            ],
            ["gone.txt"],
          ),
        );
        await s.send({ type: "chunk", index: 0, data: bytes("fre"), last: false });
        await s.send({ type: "chunk", index: 0, data: bytes("sh"), last: true });
        await s.send(end);
      }),
    );
    const proc = await remoteExec(config(target), ["x"], { pull: ["**"] });
    expect(await proc.exitCode).toBe(0);
    expect(await proc.pulled).toMatchObject({
      status: "done",
      files: 2,
      transferred: 2,
      bytes: 5,
      deleted: ["gone.txt"],
      conflicts: [],
    });
    expect(await tree(ws)).toEqual(["keep.txt", "out/link", "out/new.txt"]);
    expect(await fsp.readFile(path.join(ws, "out/new.txt"), "utf8")).toBe("fresh");
    expect((await fsp.stat(path.join(ws, "out/new.txt"))).mode & 0o777).toBe(0o755);
    expect(await fsp.readlink(path.join(ws, "out/link"))).toBe("new.txt");
  });

  it("reports conflicts when the workspace changed since push, and still writes the container's copy", async () => {
    await write(ws, { "f.txt": "v1" });
    const target = new FakeSessionTarget(
      pulling(
        async (s) => {
          await fsp.writeFile(path.join(ws, "f.txt"), "edited in the workspace meanwhile");
          await s.send(changes([await fileEntry("f.txt", "from the container")]));
          await s.send({ type: "chunk", index: 0, data: bytes("from the container"), last: true });
          await s.send(end);
        },
        () => [0],
      ),
    );
    const proc = await remoteExec(config(target), ["x"], { push: ["**"], pull: ["**"] });
    await proc.exitCode;
    expect((await proc.pulled).conflicts).toEqual(["f.txt"]);
    expect(await fsp.readFile(path.join(ws, "f.txt"), "utf8")).toBe("from the container");
  });

  it("skips files over the limits but keeps the stream in step", async () => {
    const target = new FakeSessionTarget(
      pulling(async (s) => {
        await s.send(
          changes([await fileEntry("big", "0123456789"), await fileEntry("small", "ok")]),
        );
        await s.send({ type: "chunk", index: 0, data: bytes("0123456789"), last: true });
        await s.send({ type: "chunk", index: 1, data: bytes("ok"), last: true });
        await s.send(end);
      }),
    );
    const proc = await remoteExec(config(target, { limits: { maxFileBytes: 5 } }), ["x"], {
      pull: ["**"],
    });
    await proc.exitCode;
    expect((await proc.pulled).skipped).toEqual([{ path: "big", reason: "too-large" }]);
    expect(await tree(ws)).toEqual(["small"]);
  });

  it("skips links that point outside the workspace, as push does", async () => {
    const link = (path: string, target: string) => ({
      path,
      kind: "symlink",
      mode: 0o777,
      size: 0,
      hash: new Uint8Array(),
      target,
    });
    const target = new FakeSessionTarget(
      pulling(async (s) => {
        await s.send(
          changes([link("up", "../../etc/passwd"), link("abs", "/etc"), link("ok", "a/b")]),
        );
        await s.send(end);
      }),
    );
    const proc = await remoteExec(config(target), ["x"], { pull: ["**"] });
    await proc.exitCode;
    expect((await proc.pulled).skipped).toEqual([
      { path: "up", reason: "symlink-escape" },
      { path: "abs", reason: "symlink-escape" },
    ]);
    expect(await tree(ws)).toEqual(["ok"]);
  });

  it("writes at most maxSyncFiles entries, keeping the stream in step", async () => {
    const target = new FakeSessionTarget(
      pulling(async (s) => {
        await s.send(
          changes([
            await fileEntry("a", "1"),
            await fileEntry("b", "2"),
            await fileEntry("c", "3"),
          ]),
        );
        for (const [index, data] of ["1", "2", "3"].entries()) {
          await s.send({ type: "chunk", index, data: bytes(data), last: true });
        }
        await s.send(end);
      }),
    );
    const proc = await remoteExec(config(target, { limits: { maxSyncFiles: 2 } }), ["x"], {
      pull: ["**"],
    });
    await proc.exitCode;
    expect((await proc.pulled).skipped).toEqual([{ path: "c", reason: "too-many-files" }]);
    expect(await tree(ws)).toEqual(["a", "b"]);
  });

  for (const [limit, sizes] of [
    ["maxFileBytes", [10]],
    ["maxSyncBytes", [3, 3, 3]],
  ] as const) {
    it(`counts the bytes that arrive against ${limit}, not the announced sizes`, async () => {
      const target = new FakeSessionTarget(
        pulling(async (s) => {
          const entries = await Promise.all(sizes.map((_, i) => fileEntry(`f${i}`, "x")));
          await s.send(changes(entries));
          for (const [index, size] of sizes.entries())
            await s.send({ type: "chunk", index, data: new Uint8Array(size), last: true });
          await s.send(end);
        }),
      );
      const proc = await remoteExec(
        config(target, { limits: { maxFileBytes: 5, maxSyncBytes: 5 } }),
        ["x"],
        { pull: ["**"] },
      );
      await expect(proc.exitCode).rejects.toThrow(/pull failed: f0 is larger than announced/);
      expect(await tree(ws), "no partial or temp files").toEqual([]);
    });
  }

  for (const [name, script, message] of [
    [
      "an unsafe path",
      async (s: SessionScript) =>
        s.send(changes([{ ...(await fileEntry("x", "x")), path: "../../etc/evil" }])),
      /safe relative path/,
    ],
    [
      "an unsafe deletion",
      async (s: SessionScript) => s.send(changes([], ["/etc/passwd"])),
      /safe relative path/,
    ],
    [
      "a chunk for the wrong file",
      async (s: SessionScript) => {
        await s.send(changes([await fileEntry("a", "a")]));
        await s.send({ type: "chunk", index: 3, data: bytes("a"), last: true });
      },
      /chunk for entry 3, expected 0/,
    ],
    [
      "more data than announced",
      async (s: SessionScript) => {
        await s.send(changes([await fileEntry("a", "a")]));
        await s.send({ type: "chunk", index: 0, data: bytes("ab"), last: true });
      },
      /larger than announced/,
    ],
    [
      "dying mid-pull",
      async (s: SessionScript) => {
        await s.send(changes([await fileEntry("a", "abc")]));
        await s.send({ type: "chunk", index: 0, data: bytes("a"), last: false });
        await s.end();
      },
      /ended unexpectedly/,
    ],
  ] as const) {
    it(`${name}: exitCode rejects with ExecSyncError, the workspace is untouched`, async () => {
      await write(ws, { "before.txt": "untouched" });
      const target = new FakeSessionTarget(
        pulling(async (s) => {
          await script(s);
        }),
        { exitCode: 5 },
      );
      const proc = await remoteExec(config(target), ["x"], { pull: ["**"] });
      const error = await proc.exitCode.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ExecSyncError);
      expect((error as ExecSyncError).exitCode).toBe(5);
      expect(String((error as Error).message)).toMatch(message);
      await expect(proc.pulled).rejects.toBeDefined();
      expect(await tree(ws), "no partial or temp files").toEqual(["before.txt"]);
    });
  }

  it("still resolves when the session never answers close", async () => {
    const target = new FakeSessionTarget(async (s) => {
      await openNormally(s);
      await s.next(); // close: no answer
      await s.end();
    });
    expect(await (await remoteExec(config(target), ["x"])).exitCode).toBe(0);
  });
});

describe("RemoteExecError", () => {
  it("carries code and errno", () => {
    const e = new RemoteExecError("spawn", "msg", 2);
    expect([e.name, e.code, e.errno, e.message]).toEqual(["RemoteExecError", "spawn", 2, "msg"]);
  });
});
