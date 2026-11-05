/**
 * The real remote-exec binary, driven request by request: the session's state machine, its
 * refusals, the run socket, tokens, locking, signals and liveness.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FrameReader } from "./framing";
import { decodeResponse, encodeRequest, type Entry, type Request, type Response } from "./messages";
import { startProcess, type ResolvedProcess } from "./target";
import {
  alive,
  BIN,
  eventually,
  harness,
  TESTS_DIR,
  toHex,
  type Harness,
  write,
} from "./testing/harness";
import { beginWithProtocol } from "./testing/raw";

let h: Harness;
beforeEach(async () => {
  h = await harness({ REMOTE_EXEC_ATTACH_TIMEOUT_MS: "3000" });
});
afterEach(async () => {
  await h.cleanup();
});

class Raw {
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly reader: FrameReader;
  stderr = "";
  constructor(readonly process: ResolvedProcess) {
    if (!process.stdin || !process.stdout) throw new Error("no stdio");
    this.writer = process.stdin.getWriter();
    this.reader = new FrameReader(process.stdout);
    if (process.stderr) void new Response(process.stderr).text().then((t) => (this.stderr = t));
  }
  async send(r: Request | Uint8Array): Promise<void> {
    await this.writer.write(r instanceof Uint8Array ? r : encodeRequest(r));
  }
  async next(): Promise<Response | undefined> {
    const frame = await this.reader.next();
    return frame && decodeResponse(frame);
  }
  async ask(r: Request | Uint8Array): Promise<Response | undefined> {
    await this.send(r);
    return this.next();
  }
  async closeStdin(): Promise<void> {
    await this.writer.close().catch(() => undefined);
  }
}

async function session(id = "s1", env: Record<string, string> = {}): Promise<Raw> {
  const target = Object.keys(env).length
    ? new (h.target.constructor as typeof h.target.constructor &
        (new (e: Record<string, string>) => typeof h.target))({ ...h.env, ...env })
    : h.target;
  return new Raw(
    await startProcess(target, [BIN, "session", "--id", id], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
}

const begin = (id = "s1", lock = false, lockTimeoutMs = 1000): Request => ({
  type: "begin",
  id,
  root: h.ctr,
  lock,
  lockTimeoutMs,
});
const prepare = (
  argv: string[],
  extra: Partial<{ cwd: string; user: string; env: Record<string, string>; pull: string[] }> = {},
): Request => ({
  type: "prepare",
  spec: { argv, cwd: extra.cwd ?? h.ctr, env: extra.env ?? {}, user: extra.user ?? "" },
  pull: { root: h.ctr, globs: extra.pull ?? [] },
});

async function run(
  id: string,
  token: Uint8Array | string,
  options: { stdin?: "pipe" } = {},
): Promise<ResolvedProcess> {
  return startProcess(
    h.target,
    [BIN, "run", "--session", id, "--token", typeof token === "string" ? token : toHex(token)],
    { stdout: "pipe", stderr: "pipe", ...options },
  );
}

async function prepared(s: Raw, argv: string[], extra = {}): Promise<Uint8Array> {
  expect(await s.ask(begin())).toMatchObject({ type: "begun" });
  const p = await s.ask(prepare(argv, extra));
  if (p?.type !== "prepared") throw new Error(`expected prepared, got ${JSON.stringify(p)}`);
  return p.token;
}

const entry = (p: string, content: string): Entry => ({
  path: p,
  kind: "file",
  mode: 0o644,
  size: content.length,
  hash: new Uint8Array(createHash("sha256").update(content).digest()),
  target: "",
});

describe("command line", () => {
  it("--version names the binary, protocol and the hash of its own executable", async () => {
    const p = await startProcess(h.target, [BIN, "--version"], { stdout: "pipe" });
    const out = (await new Response(p.stdout).text()).trim();
    const hash = createHash("sha256").update(fs.readFileSync(BIN)).digest("hex");
    // The release workflow keeps the crate's version in step with the package's.
    const version = /^version = "([^"]+)"/m.exec(
      fs.readFileSync(path.join(TESTS_DIR, "../Cargo.toml"), "utf8"),
    )?.[1];
    expect(out).toBe(`remote-exec ${version} protocol 1 sha256:${hash}`);
  });

  it("usage errors exit 2; run without a reachable session exits 125", async () => {
    for (const args of [
      [],
      ["bogus"],
      ["session"],
      ["session", "--id"],
      ["run", "--session", "x"],
      ["session", "--id", "../evil"],
    ]) {
      const p = await startProcess(h.target, [BIN, ...args], { stdout: "pipe", stderr: "pipe" });
      expect(await p.exitCode, args.join(" ")).toBe(2);
    }
    const bad = await run("nosuch", "zz");
    expect(await bad.exitCode).toBe(125);
    const missing = await run("nosuch", "00");
    expect(await missing.exitCode).toBe(125);
    expect(await new Response(missing.stderr).text()).toMatch(/can't reach session nosuch/);
  });
});

describe("session state machine", () => {
  it("Begin must come first, once, with our protocol and id", async () => {
    let s = await session();
    expect(await s.ask(prepare(["true"]))).toMatchObject({
      type: "error",
      code: "protocol",
      message: "Begin must come first",
    });
    expect(await s.process.exitCode).toBe(1);

    s = await session();
    expect(await s.ask(beginWithProtocol("s1", h.ctr, 2))).toMatchObject({
      type: "error",
      code: "protocol",
      message: expect.stringMatching(/protocol 2 isn't supported/),
    });

    s = await session();
    expect(await s.ask(begin("other"))).toMatchObject({
      type: "error",
      code: "protocol",
      message: expect.stringMatching(/but this is "s1"/),
    });

    s = await session();
    expect(await s.ask(begin())).toMatchObject({
      type: "begun",
      protocol: 1,
      arch: process.arch === "x64" ? "x86_64" : "aarch64",
    });
    expect(await s.ask(begin())).toMatchObject({
      type: "error",
      code: "protocol",
      message: "Begin twice",
    });
  });

  it("refuses requests out of order", async () => {
    for (const r of [
      { type: "awaitStart" },
      { type: "pushEnd" },
      { type: "chunk", index: 0, data: new Uint8Array(), last: true },
      { type: "pull" },
    ] as Request[]) {
      const s = await session();
      await s.ask(begin());
      expect(await s.ask(r), r.type).toMatchObject({ type: "error", code: "protocol" });
      expect(await s.process.exitCode).toBe(1);
    }
    const s = await session();
    await prepared(s, ["true"]);
    expect(await s.ask(prepare(["true"]))).toMatchObject({
      type: "error",
      message: "Prepare out of order",
    });
  });

  it("refuses bad specs and globs", async () => {
    for (const [r, message] of [
      [prepare([]), /argv is empty/],
      [prepare(["true"], { user: "root" }), /uid:gid/],
      [prepare(["true"], { pull: ["/etc/**"] }), /relative to the root/],
      [
        { type: "push", selection: { root: h.ctr, globs: ["../x"] }, manifest: [], owner: "" },
        /relative to the root/,
      ],
      [
        {
          type: "push",
          selection: { root: h.ctr, globs: ["**"] },
          manifest: [entry("../../etc/passwd", "x")],
          owner: "",
        },
        /bad path/,
      ],
      [
        { type: "push", selection: { root: h.ctr, globs: ["**"] }, manifest: [], owner: "admin" },
        /uid:gid/,
      ],
    ] as [Request, RegExp][]) {
      const s = await session();
      await s.ask(begin());
      expect(await s.ask(r)).toMatchObject({
        type: "error",
        code: "protocol",
        message: expect.stringMatching(message),
      });
    }
  });

  it("garbage on stdin is a protocol error and the session exits", async () => {
    const s = await session();
    await s.send(new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
    expect(await s.next()).toMatchObject({ type: "error", code: "protocol" });
    expect(await s.process.exitCode).toBe(1);
  });

  it("a root that isn't absolute is refused", async () => {
    const s = await session();
    expect(
      await s.ask({ type: "begin", id: "s1", root: "relative", lock: false, lockTimeoutMs: 0 }),
    ).toMatchObject({ type: "error", message: "root must be absolute" });
  });

  it("Close answers closed, exits 0 and removes the socket", async () => {
    const s = await session();
    await s.ask(begin());
    expect(fs.existsSync(path.join(h.runDir, "s1.sock"))).toBe(true);
    expect((fs.statSync(path.join(h.runDir, "s1.sock")).mode & 0o777).toString(8)).toBe("600");
    expect(await s.ask({ type: "close" })).toEqual({ type: "closed" });
    expect(await s.process.exitCode).toBe(0);
    expect(fs.existsSync(path.join(h.runDir, "s1.sock"))).toBe(false);
  });
});

describe("push", () => {
  it("refuses chunks that weren't wanted, and keeps going after an I/O error", async () => {
    await write(h.ctr, { "same.txt": "same" });
    const s = await session();
    await s.ask(begin());
    const want = await s.ask({
      type: "push",
      selection: { root: h.ctr, globs: ["**"] },
      manifest: [entry("same.txt", "same"), entry("new.txt", "n")],
      owner: "",
    });
    expect(want).toEqual({ type: "want", indices: [1] });
    expect(
      await s.ask({ type: "chunk", index: 0, data: new Uint8Array([1]), last: true }),
    ).toMatchObject({
      type: "error",
      code: "protocol",
      message: expect.stringMatching(/wasn't wanted/),
    });
  });

  it("won't write through a symlink planted in the container", async () => {
    const outside = path.join(h.base, "outside");
    await fsp.mkdir(outside);
    await fsp.mkdir(h.ctr, { recursive: true });
    await fsp.symlink(outside, path.join(h.ctr, "dir"));
    const s = await session();
    await s.ask(begin());
    expect(
      await s.ask({
        type: "push",
        selection: { root: h.ctr, globs: ["**"] },
        manifest: [entry("dir/evil", "x")],
        owner: "",
      }),
    ).toEqual({ type: "want", indices: [0] });
    expect(
      await s.ask({ type: "chunk", index: 0, data: new TextEncoder().encode("x"), last: true }),
    ).toMatchObject({
      type: "error",
      code: "io",
      message: expect.stringMatching(/isn't a directory/),
    });
    // An I/O error isn't fatal: the session still answers.
    expect(await s.ask({ type: "pushEnd" })).toMatchObject({
      type: "pushReport",
      report: { skipped: [{ path: "dir/evil", reason: "incomplete" }] },
    });
    expect(await fsp.readdir(outside)).toEqual([]);
  });
});

describe("run and the socket", () => {
  it("a wrong token is rejected and the right one still works; tokens are single-use", async () => {
    const s = await session();
    const token = await prepared(s, ["sh", "-c", "echo started"]);
    await s.send({ type: "awaitStart" });
    const wrong = await run("s1", "00".repeat(16));
    expect(await wrong.exitCode).toBe(125);
    expect(await new Response(wrong.stderr).text()).toMatch(/wrong token/);
    const right = await run("s1", token);
    expect(await s.next()).toMatchObject({ type: "started" });
    expect(await new Response(right.stdout).text()).toBe("started\n");
    expect(await right.exitCode).toBe(0);
    // The same token again: nobody accepts it, and closing the session ends it.
    const replay = await run("s1", token);
    expect(await s.ask({ type: "close" })).toEqual({ type: "closed" });
    expect(await replay.exitCode).toBe(125);
  });

  it("times out waiting for run", async () => {
    const s = await session("s1", { REMOTE_EXEC_ATTACH_TIMEOUT_MS: "200" });
    await prepared(s, ["true"]);
    expect(await s.ask({ type: "awaitStart" })).toMatchObject({
      type: "error",
      code: "attach-timeout",
    });
  });

  it("reports a command that can't start to both sides", async () => {
    const s = await session();
    const token = await prepared(s, ["/no/such/binary"]);
    await s.send({ type: "awaitStart" });
    const r = await run("s1", token);
    expect(await s.next()).toMatchObject({ type: "error", code: "spawn", errno: 2 });
    expect(await r.exitCode).toBe(125);
    expect(await new Response(r.stderr).text()).toMatch(/\/no\/such\/binary/);
  });

  it("stdin is the run's: piped through, and EOF reaches the command", async () => {
    const s = await session();
    const token = await prepared(s, ["sh", "-c", "cat; echo done"]);
    await s.send({ type: "awaitStart" });
    const r = await run("s1", token, { stdin: "pipe" });
    expect(await s.next()).toMatchObject({ type: "started" });
    const w = r.stdin?.getWriter();
    await w?.write(new TextEncoder().encode("piped\n"));
    await w?.close();
    expect(await new Response(r.stdout).text()).toBe("piped\ndone\n");
  });

  it("signals sent to run reach the command", async () => {
    const s = await session();
    const token = await prepared(s, ["sleep", "100"]);
    await s.send({ type: "awaitStart" });
    const r = await run("s1", token);
    const started = await s.next();
    r.kill(15);
    expect(await r.exitCode).toBe(143);
    expect(started?.type === "started" && alive(started.pid)).toBe(false);
  });

  it("Signal requests reach the whole group; out-of-range and idle signals are harmless", async () => {
    const s = await session();
    const token = await prepared(s, ["sh", "-c", "sleep 100 & wait"]);
    expect(await s.ask({ type: "signal", signal: 15 })).toEqual({ type: "signaled" }); // nothing running yet
    await s.send({ type: "awaitStart" });
    const r = await run("s1", token);
    await s.next();
    expect(await s.ask({ type: "signal", signal: 0 })).toEqual({ type: "signaled" });
    expect(await s.ask({ type: "signal", signal: 200 })).toEqual({ type: "signaled" });
    expect(await s.ask({ type: "signal", signal: 2 })).toEqual({ type: "signaled" });
    expect(await r.exitCode).toBe(130);
  });

  it("if run dies, the session kills the command", async () => {
    const s = await session();
    const token = await prepared(s, ["sh", "-c", "trap '' TERM; sleep 100"]);
    await s.send({ type: "awaitStart" });
    const r = await run("s1", token);
    const started = await s.next();
    const pid = started?.type === "started" ? started.pid : 0;
    expect(alive(pid)).toBe(true);
    r.kill(9);
    await eventually(() => !alive(pid));
  });

  it("if the host goes away, everything stops, the socket goes and the lock is free", async () => {
    const s = await session();
    expect(await s.ask(begin("s1", true))).toMatchObject({ type: "begun" });
    const p = await s.ask(prepare(["sh", "-c", "sleep 100 & sleep 100"]));
    await s.send({ type: "awaitStart" });
    const r = await run("s1", p?.type === "prepared" ? p.token : new Uint8Array());
    const started = await s.next();
    const pid = started?.type === "started" ? started.pid : 0;
    await s.closeStdin();
    expect(await s.process.exitCode).toBe(0);
    // run reports the killed command's status if it hears it in time, else 125.
    expect([125, 137]).toContain(await r.exitCode);
    await eventually(() => !alive(pid));
    expect(fs.existsSync(path.join(h.runDir, "s1.sock"))).toBe(false);
    const next = await session("s2");
    expect(await next.ask(begin("s2", true, 0))).toMatchObject({ type: "begun", lockWaitMs: 0 });
  });
});

describe("lock and pull", () => {
  it("a second locking session waits, then fails with busy", async () => {
    const a = await session("a");
    expect(await a.ask(begin("a", true))).toMatchObject({ type: "begun" });
    const b = await session("b");
    const started = Date.now();
    expect(await b.ask(begin("b", true, 300))).toMatchObject({ type: "error", code: "busy" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    // Without the lock flag, b doesn't wait at all.
    const c = await session("c");
    expect(await c.ask(begin("c", false))).toMatchObject({ type: "begun", lockWaitMs: 0 });
  });

  it("streams changed files in order, then pullEnd", async () => {
    await write(h.ctr, { "keep.txt": "same", "gone.txt": "bye" });
    const s = await session();
    const token = await prepared(
      s,
      ["sh", "-c", "head -c 2500000 /dev/zero > big; echo hi > small; rm gone.txt"],
      { pull: ["**"] },
    );
    await s.send({ type: "awaitStart" });
    const r = await run("s1", token);
    await s.next();
    expect(await r.exitCode).toBe(0);
    const changes = await s.ask({ type: "pull" });
    expect(changes).toMatchObject({
      type: "changes",
      changed: [
        { path: "big", size: 2500000 },
        { path: "small", size: 3 },
      ],
      deleted: ["gone.txt"],
    });
    const chunks: [number, number, boolean][] = [];
    for (let m = await s.next(); m?.type === "chunk"; m = await s.next()) {
      chunks.push([m.index, m.data.byteLength, m.last]);
      if (m.index === 1 && m.last) break;
    }
    expect(chunks).toEqual([
      [0, 1048576, false],
      [0, 1048576, false],
      [0, 402848, true],
      [1, 3, true],
    ]);
    expect(await s.next()).toMatchObject({
      type: "pullEnd",
      report: { written: 2, bytes: 2500003, deleted: ["gone.txt"] },
    });
  });
});
