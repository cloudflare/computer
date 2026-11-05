/**
 * The codemode host module (`codemode:exec`) and the isolate-side facade (`remote-exec`), against the
 * real binary. The facade's source runs for real: its `codemode:exec` import is bound to the host
 * functions through a JSON round trip, as computer's bridge does.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceModuleCallContext, WorkspaceRuntimeValue } from "../runtime/types";
import { bundledRemoteExec } from "./bundle";
import { FACADE_SOURCE } from "./facade";
import type { RemoteExecBinaries } from "./install";
import { createExecModule, type ExecModuleOptions } from "./module";
import { BIN, eventually, harness, type Harness, write } from "./testing/harness";

type Fn = (args: readonly WorkspaceRuntimeValue[], context: WorkspaceModuleCallContext) => unknown;
type Fns = Record<string, Fn>;

let h: Harness;
let calls = 0;
let binaries: RemoteExecBinaries;
beforeAll(async () => {
  const bytes = new Uint8Array(await fsp.readFile(BIN)).buffer;
  binaries = bundledRemoteExec({ x86_64: bytes, aarch64: bytes });
});
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.cleanup();
});

function makeContext(
  overrides: Partial<WorkspaceModuleCallContext> = {},
): WorkspaceModuleCallContext & { abort(): void } {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    deadline: Date.now() + 60_000,
    access: "read-write",
    callId: `run1:${calls++}`,
    resolvePath: async (p: string) => p,
    interrupt: async () => Promise.reject(new Error("no")),
    abort: () => controller.abort(),
    ...overrides,
  } as WorkspaceModuleCallContext & { abort(): void };
}

function makeModule(extra: Partial<ExecModuleOptions> = {}): Fns {
  const factory = createExecModule({
    target: () => h.target,
    fs: () => h.config.fs,
    workspaceRoot: "/workspace",
    containerRoot: h.ctr,
    agentPath: BIN,
    binaries,
    output: { dir: "/workspace/.out" },
    runTimeoutMs: 60_000,
    ...extra,
  });
  return factory({} as never) as Fns;
}

// Results are JSON from the bridge; the tests poke at them freely.
// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;

/** Call a host function with arguments and result crossing as JSON, as through the bridge. */
async function call(
  fns: Fns,
  name: string,
  args: unknown[],
  context = makeContext(),
): Promise<Json> {
  const fn = fns[name];
  if (!fn) throw new Error(`no ${name}`);
  const result = await fn(JSON.parse(JSON.stringify(args)) as WorkspaceRuntimeValue[], context);
  return JSON.parse(JSON.stringify(result ?? null));
}

const b64 = (s: string) => Buffer.from(s).toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString();

describe("codemode:exec exec (one host call)", () => {
  it("pushes, runs and pulls, returning text output and sync reports", async () => {
    await write(h.ws, { "src/in.txt": "hello" });
    const result = await call(makeModule(), "exec", [
      [
        "sh",
        "-c",
        'cat src/in.txt; read x; echo "stdin=$x"; echo $GREETING; mkdir -p out; echo made > out/f; echo err >&2; exit 2',
      ],
      {
        push: ["src/**"],
        pull: ["out/**"],
        stdin: "piped\n",
        env: { GREETING: "hi" },
        cwd: "/workspace",
      },
    ]);
    expect(result).toMatchObject({
      exitCode: 2,
      stdout: "hellostdin=piped\nhi\n",
      stderr: "err\n",
    });
    expect(result.sync.pushed).toMatchObject({ status: "done", files: 1, transferred: 1 });
    expect(result.sync.pulled).toMatchObject({ status: "done", files: 1 });
    expect(result.truncated).toBeUndefined();
    expect(await fsp.readFile(path.join(h.ws, "out/f"), "utf8")).toBe("made\n");
  });

  it("follows the Workspace's output settings: tail kept, full output saved", async () => {
    const fns = makeModule({ output: { maxLines: 5, dir: "/workspace/.out" } });
    const result = await call(fns, "exec", [["seq", "1", "1000"]]);
    expect(result.stdout).toBe("996\n997\n998\n999\n1000\n");
    expect(result.truncated.stdout).toMatchObject({
      status: "saved",
      totalLines: 1000,
      firstLine: 996,
    });
    expect(result.truncated.stderr).toBeUndefined();
    const saved = result.truncated.stdout.path as string;
    expect(saved).toMatch(/^\/workspace\/\.out\/x.+\.stdout\.log$/);
    expect(
      (await fsp.readFile(path.join(h.ws, saved.slice("/workspace/".length)), "utf8")).split("\n"),
    ).toHaveLength(1001);
  });

  it("takes binary stdin as base64", async () => {
    const result = await call(makeModule(), "exec", [
      ["od", "-An", "-tx1"],
      { stdinBase64: Buffer.from([0, 1, 255]).toString("base64") },
    ]);
    expect(result.stdout.trim()).toBe("00 01 ff");
  });

  it("validates everything the isolate sends", async () => {
    const fns = makeModule();
    for (const [args, message] of [
      [[], /argv/],
      [[[]], /argv/],
      [["ls"], /argv/],
      [[["ls", 3]], /argv/],
      [[["ls"], "opts"], /options must be an object/],
      [[["ls"], { nope: 1 }], /unknown option "nope"/],
      [[["ls"], { env: { A: 1 } }], /env "A" must be a string/],
      [[["ls"], { stdin: 5 }], /stdin must be/],
      [[["ls"], { stdout: "file" }], /stdout must be one of/],
      [[["ls"], { push: "src/**" }], /push must be an array/],
      [[["ls"], { user: "root" }], /numeric/],
      [[["ls"], { pull: ["/etc/**"] }], /outside/],
    ] as [unknown[], RegExp][]) {
      await expect(call(fns, "exec", args), JSON.stringify(args)).rejects.toThrow(message);
    }
    await expect(call(fns, "exec", [["true"]], makeContext({ access: "read" }))).rejects.toThrow(
      /write access/,
    );
  });

  it("read-only: refuses pull and user, in exec and spawn, before starting anything", async () => {
    const fns = makeModule({ readOnly: true });
    for (const name of ["exec", "spawn"]) {
      await expect(
        call(fns, name, [["true"], { pull: ["**"] }], makeContext({ access: "read" })),
      ).rejects.toThrow(/can only read files, so it can't pull/);
      await expect(
        call(fns, name, [["true"], { user: "0:0" }], makeContext({ access: "read" })),
      ).rejects.toThrow(/run as nobody \(65534:65534\) and it can't choose a user/);
    }
    expect(h.target.children).toHaveLength(0);
  });

  it.skipIf(process.getuid?.() !== 0)("read-only: still saves long output", async () => {
    await fsp.chmod(h.base, 0o755);
    const fns = makeModule({ readOnly: true, output: { maxLines: 5, dir: "/workspace/.out" } });
    const result = await call(fns, "exec", [["seq", "1", "1000"]], makeContext({ access: "read" }));
    expect(result.truncated.stdout).toMatchObject({ status: "saved", totalLines: 1000 });
  });

  // Switching user needs root, which CI's images don't run as.
  it.skipIf(process.getuid?.() !== 0)(
    "read-only: runs as nobody, and pushed files stay root's",
    async () => {
      await write(h.ws, { "a.txt": "x" });
      await fsp.chmod(h.base, 0o755);
      const result = await call(
        makeModule({ readOnly: true }),
        "exec",
        [
          ["sh", "-c", "id -u; id -g; stat -c %u:%g a.txt; echo changed > a.txt"],
          { push: ["a.txt"] },
        ],
        makeContext({ access: "read" }),
      );
      expect(result.stdout.trim().split("\n")).toEqual(["65534", "65534", "0:0"]);
      expect(result.stderr).toMatch(/Permission denied/);
      expect(result.exitCode).not.toBe(0);
    },
  );

  it("aborting the host call kills the command", async () => {
    const fns = makeModule();
    const context = makeContext();
    const pending = call(fns, "exec", [["sleep", "100"]], context);
    await new Promise((r) => setTimeout(r, 300));
    context.abort();
    expect((await pending).exitCode).toBe(137);
  });

  it("aborting the host call while the command starts kills it once it has", async () => {
    const fns = makeModule();
    const context = makeContext();
    const pending = call(fns, "exec", [["sleep", "100"]], context);
    context.abort();
    expect((await pending).exitCode).toBe(137);
  });

  it("installs the bundled binary once, then reuses it", async () => {
    const agentPath = path.join(h.base, "bin/remote-exec");
    const fns = makeModule({ agentPath });
    expect((await call(fns, "exec", [["echo", "one"]])).stdout).toBe("one\n");
    expect((await call(fns, "exec", [["echo", "two"]])).stdout).toBe("two\n");
    const installs = h.target.children.filter(
      ({ cmd }) => cmd[0] === "sh" && cmd[2]?.includes("mv -f"),
    );
    expect(installs).toHaveLength(1);
  });

  it("describes itself for the model", () => {
    const factory = createExecModule({
      target: () => h.target,
      fs: () => h.config.fs,
      binaries,
      runTimeoutMs: 30 * 60 * 1000,
    });
    expect(factory.description).toMatch(/push/);
    expect(factory.description).toMatch(/remote-exec/);
    expect(factory.description).toMatch(/times out, after 30 minutes/);
  });

  it("kills the command when the calling code's deadline passes", async () => {
    const fns = makeModule();
    const context = makeContext();
    const started = Date.now();
    const pending = call(fns, "exec", [["sleep", "30"]], context).then(
      (result: Json) => ({ result }),
      (error: unknown) => ({ error }),
    );
    setTimeout(() => context.abort(), 500);
    const outcome = await pending;
    // Killed rather than left running: either an error, or the exit of a killed process.
    expect("error" in outcome || outcome.result.exitCode !== 0).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("codemode:exec primitives", () => {
  async function readAll(fns: Fns, id: string, stream: "stdout" | "stderr"): Promise<string> {
    let out = "";
    for (;;) {
      const { data, eof } = await call(fns, "read", [id, stream, 200]);
      out += unb64(data);
      if (eof) return out;
    }
  }

  it("spawn, write, closeStdin, read and wait", async () => {
    const fns = makeModule();
    const { id, pid, pushed } = await call(fns, "spawn", [
      ["sh", "-c", "tr a-z A-Z; echo bye >&2"],
      { stdin: "pipe" },
    ]);
    expect(pid).toBeGreaterThan(1);
    expect(pushed.status).toBe("skipped");
    await call(fns, "write", [id, b64("streamed ")]);
    await call(fns, "write", [id, b64("input\n")]);
    await call(fns, "closeStdin", [id]);
    const [out, err] = await Promise.all([readAll(fns, id, "stdout"), readAll(fns, id, "stderr")]);
    expect([out, err]).toEqual(["STREAMED INPUT\n", "bye\n"]);
    const result = await call(fns, "wait", [id]);
    expect(result.exitCode).toBe(0);
    expect(unb64(result.stdout)).toBe("STREAMED INPUT\n");
    // Fully read and waited: forgotten.
    await expect(call(fns, "read", [id, "stdout", 0])).rejects.toThrow(/no running execution/);
  });

  it("keeps output readable after the command exits, until each stream is read", async () => {
    const fns = makeModule();
    const { id } = await call(fns, "spawn", [["sh", "-c", "echo out; echo err >&2"]]);
    expect((await call(fns, "wait", [id])).exitCode).toBe(0);
    expect(await readAll(fns, id, "stdout")).toBe("out\n");
    expect(await readAll(fns, id, "stderr")).toBe("err\n");
    await expect(call(fns, "read", [id, "stdout", 0])).rejects.toThrow(/no running execution/);
  });

  it("forgets an exited command once its unread streams are cancelled", async () => {
    const fns = makeModule();
    const { id } = await call(fns, "spawn", [["sh", "-c", "echo out; echo err >&2"]]);
    await call(fns, "wait", [id]);
    await call(fns, "cancel", [id, "stdout"]);
    await expect(call(fns, "read", [id, "stdout", 0])).rejects.toThrow(/cancelled/);
    expect(await readAll(fns, id, "stderr")).toBe("err\n");
    await expect(call(fns, "read", [id, "stderr", 0])).rejects.toThrow(/no running execution/);
    const other = await call(fns, "spawn", [["echo", "x"]]);
    await call(fns, "wait", [other.id]);
    await call(fns, "cancel", [other.id]);
    await expect(call(fns, "read", [other.id, "stdout", 0])).rejects.toThrow(
      /no running execution/,
    );
  });

  it("forgets unread output once the code that spawned it has timed out", async () => {
    const fns = makeModule({ runTimeoutMs: 300 });
    const { id } = await call(fns, "spawn", [["echo", "x"]]);
    await call(fns, "wait", [id]);
    await new Promise((r) => setTimeout(r, 400));
    await expect(call(fns, "read", [id, "stdout", 0])).rejects.toThrow(/no running execution/);
  });

  it("read returns nothing yet without waiting past waitMs", async () => {
    const fns = makeModule();
    const { id } = await call(fns, "spawn", [["sh", "-c", "sleep 1; echo late"]]);
    const started = Date.now();
    expect(await call(fns, "read", [id, "stdout", 100])).toEqual({ data: "", eof: false });
    expect(Date.now() - started).toBeLessThan(900);
    expect(await readAll(fns, id, "stdout")).toBe("late\n");
    await call(fns, "wait", [id]);
  });

  it("streams large output with backpressure when it's being read", async () => {
    const fns = makeModule({ maxStreamBuffer: 4096 });
    const { id } = await call(fns, "spawn", [
      ["sh", "-c", "head -c 3000000 /dev/zero | tr '\\0' a"],
    ]);
    let total = 0;
    for (;;) {
      const { data, eof } = await call(fns, "read", [id, "stdout", 200]);
      total += Buffer.from(data, "base64").byteLength;
      if (eof) break;
    }
    expect(total).toBe(3_000_000);
    expect((await call(fns, "wait", [id])).exitCode).toBe(0);
  });

  // seq writes many small chunks; printf writes one larger than the read-ahead.
  for (const command of ["seq 1 5000", "printf '%04000d\\n' 5000"]) {
    it(`stops buffering a stream nobody reads, but wait() still has its output: ${command}`, async () => {
      const fns = makeModule({ maxStreamBuffer: 1024 });
      const { id } = await call(fns, "spawn", [["sh", "-c", command]]);
      const result = await call(fns, "wait", [id]);
      expect(result.exitCode).toBe(0);
      expect(unb64(result.stdout).trim().split("\n").at(-1)).toMatch(/5000$/);
      await expect(call(fns, "read", [id, "stdout", 0])).rejects.toThrow(/read-ahead/);
    });
  }

  it("kill signals the command; abort kills it and skips pull", async () => {
    const fns = makeModule();
    const a = await call(fns, "spawn", [["sleep", "100"]]);
    await call(fns, "kill", [a.id, 15]);
    expect((await call(fns, "wait", [a.id])).exitCode).toBe(143);
    const b = await call(fns, "spawn", [["sleep", "100"], { pull: ["**"] }]);
    await call(fns, "abort", [b.id]);
    const result = await call(fns, "wait", [b.id]);
    expect(result.exitCode).toBe(137);
    expect(result.sync.pulled.status).toBe("skipped");
  });

  it("unknown ids and missing stdin are errors", async () => {
    const fns = makeModule();
    for (const name of ["write", "read", "wait", "kill", "abort", "closeStdin", "cancel"]) {
      await expect(call(fns, name, ["nope", ""]), name).rejects.toThrow(/no running execution/);
    }
    const { id } = await call(fns, "spawn", [["cat"]]);
    await expect(call(fns, "write", [id, b64("x")])).rejects.toThrow(/stdin isn't "pipe"/);
    await call(fns, "wait", [id]);
  });
});

describe("remote-exec facade (the isolate-side ExecProcess)", () => {
  // oxlint-disable-next-line typescript/no-explicit-any
  type Facade = { exec(argv: string[], options?: Record<string, unknown>): Promise<any> };
  let facade: Facade;
  let contexts: ReturnType<typeof makeContext>[];

  beforeEach(async () => {
    const fns = makeModule();
    contexts = [];
    (globalThis as Record<string, unknown>).__wsExec = (name: string, args: unknown[]) => {
      const context = makeContext();
      contexts.push(context);
      return call(fns, name, args, context);
    };
    const dir = path.join(h.base, "facade");
    await fsp.mkdir(dir);
    const names = ["spawn", "write", "closeStdin", "read", "wait", "cancel", "kill", "abort"];
    await fsp.writeFile(
      path.join(dir, "ws-exec.mjs"),
      names
        .map(
          (n) =>
            `export const ${n} = (...args) => globalThis.__wsExec(${JSON.stringify(n)}, args);`,
        )
        .join("\n"),
    );
    await fsp.writeFile(
      path.join(dir, "facade.mjs"),
      FACADE_SOURCE.replace('from "codemode:exec"', 'from "./ws-exec.mjs"'),
    );
    facade = (await import(pathToFileURL(path.join(dir, "facade.mjs")).href)) as Facade;
  });

  it("gives streams, a writable stdin and the command's pid", async () => {
    const p = await facade.exec(
      ["sh", "-c", 'while read l; do echo "got $l"; done; echo done >&2'],
      { stdin: "pipe" },
    );
    expect(p.pid).toBeGreaterThan(1);
    const w = p.stdin.getWriter();
    await w.write(new TextEncoder().encode("a\nb\n"));
    await w.close();
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exitCode,
    ]);
    expect([out, err, code]).toEqual(["got a\ngot b\n", "done\n", 0]);
  });

  it("output() returns exact bytes once, and only before the streams are read", async () => {
    const p = await facade.exec(["printf", "a\\000b\\377"]);
    const o = await p.output();
    expect(Array.from(new Uint8Array(o.stdout))).toEqual([97, 0, 98, 255]);
    expect(o.exitCode).toBe(0);
    expect(o.sync.pulled.status).toBe("skipped");
    await expect(p.output()).rejects.toThrow(TypeError);
    const q = await facade.exec(["echo", "x"]);
    await new Response(q.stdout).text();
    await expect(q.output()).rejects.toThrow(TypeError);
  });

  it("doesn't poll unless a stream is read: output() costs spawn, wait and cancel", async () => {
    const before = contexts.length;
    const p = await facade.exec(["echo", "quiet"]);
    await p.output();
    // spawn, the wait behind exitCode/pulled/truncated/output (one shared call), and the cancel
    // that frees the streams output() made unreadable.
    expect(contexts.length - before).toBe(3);
  });

  it("streams stay readable after exitCode resolves", async () => {
    const p = await facade.exec(["sh", "-c", "echo out; echo err >&2"]);
    expect(await p.exitCode).toBe(0);
    expect(await new Response(p.stdout).text()).toBe("out\n");
    expect(await new Response(p.stderr).text()).toBe("err\n");
  });

  it("output() works with both streams ignored", async () => {
    const p = await facade.exec(["true"], { stdout: "ignore", stderr: "ignore" });
    expect(await p.exitCode).toBe(0);
    expect((await p.output()).exitCode).toBe(0);
  });

  it("accepts string, bytes and ReadableStream stdin", async () => {
    expect(
      new TextDecoder().decode(
        (await (await facade.exec(["cat"], { stdin: "text" })).output()).stdout,
      ),
    ).toBe("text");
    expect(
      new TextDecoder().decode(
        (await (await facade.exec(["cat"], { stdin: new TextEncoder().encode("bytes") })).output())
          .stdout,
      ),
    ).toBe("bytes");
    const p = await facade.exec(["cat"], { stdin: new Blob(["from ", "a stream"]).stream() });
    expect(await new Response(p.stdout).text()).toBe("from a stream");
    await expect(facade.exec(["cat"], { stdin: 42 })).rejects.toThrow(TypeError);
  });

  it("an ignored stream is undefined", async () => {
    const p = await facade.exec(["echo", "x"], { stdout: "ignore" });
    expect(p.stdout).toBeUndefined();
    expect(p.stderr).toBeDefined();
    expect(new Uint8Array((await p.output()).stdout).byteLength).toBe(0);
  });

  it("exitCode resolves after pull, so the files are already in the workspace", async () => {
    const p = await facade.exec(["sh", "-c", "echo made > result.txt"], { pull: ["result.txt"] });
    expect(await p.exitCode).toBe(0);
    expect(await fsp.readFile(path.join(h.ws, "result.txt"), "utf8")).toBe("made\n");
    expect((await p.pulled).files).toBe(1);
  });

  it("signal: an abort kills the command and skips pull; an aborted signal throws before spawning", async () => {
    const controller = new AbortController();
    const p = await facade.exec(["sleep", "100"], { signal: controller.signal, pull: ["**"] });
    setTimeout(() => controller.abort(), 200);
    expect(await p.exitCode).toBe(137);
    expect((await p.pulled).status).toBe("skipped");
    const spawned = h.target.children.length;
    await expect(facade.exec(["true"], { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(h.target.children.length).toBe(spawned);
  });

  it("kill() sends the signal and checks its range", async () => {
    const p = await facade.exec(["sleep", "100"]);
    expect(() => p.kill(0)).toThrow(RangeError);
    expect(() => p.kill(65)).toThrow(RangeError);
    p.kill(2);
    expect(await p.exitCode).toBe(130);
  });

  it("truncated resolves with computer's TruncatedOutput when output is long", async () => {
    const p = await facade.exec(["seq", "1", "100000"]);
    const t = await p.truncated;
    expect(t.stdout).toMatchObject({ status: "saved", totalLines: 100000 });
    await eventually(async () => (await p.exitCode) === 0);
  });
});
