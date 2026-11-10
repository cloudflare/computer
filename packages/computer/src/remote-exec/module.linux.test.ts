/**
 * `codemode:exec` against the real binary. `exec()` returns a codemode object shaped like
 * `ctx.container.exec()`'s process; most tests use that object on the host, as the bridge would
 * on code's behalf, and a few go through the bridge itself, journal and all.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeValue, encodeValue } from "../backends/codemode/journal";
import { type BridgeJournal, type BridgeResponse, WorkspaceRuntimeBridge } from "../runtime/bridge";
import type { WorkspaceRuntimeCapability } from "../runtime/capability";
import {
  codemodeMember,
  codemodeModuleDefinition,
  type CodemodeMember,
  type WorkspaceModuleScopeEnd,
} from "../runtime/codemode-module";
import type { WorkspaceModuleCallContext, WorkspaceRuntimeValue } from "../runtime/types";
import { bundledRemoteExec } from "./bundle";
import type { RemoteExecBinaries } from "./install";
import { createExecModule, type ExecModuleOptions, type RemoteExecOutput } from "./module";
import { BIN, harness, type Harness, write } from "./testing/harness";

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
): WorkspaceModuleCallContext {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    access: "read-write",
    callId: `run1:${calls++}`,
    resolvePath: async (p: string) => p,
    interrupt: async () => Promise.reject(new Error("no")),
    ...overrides,
  } as WorkspaceModuleCallContext;
}

function moduleOptions(extra: Partial<ExecModuleOptions> = {}): ExecModuleOptions {
  return {
    target: () => h.target,
    fs: () => h.config.fs,
    workspaceRoot: "/workspace",
    containerRoot: h.ctr,
    agentPath: BIN,
    binaries,
    output: { dir: "/workspace/.out" },
    ...extra,
  };
}

function definitionOf(extra: Partial<ExecModuleOptions> = {}) {
  const definition = codemodeModuleDefinition(createExecModule(moduleOptions(extra)));
  if (definition === undefined) throw new Error("not a codemode module");
  return definition;
}

type HostObject = Record<string | symbol, unknown>;

/** A process as code sees it, made from the host object the way the bridge does it for code. */
interface Proc {
  pid: number;
  isPty: boolean;
  stdin: WritableStream<Uint8Array> | null;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exitCode: Promise<number>;
  output(): Promise<RemoteExecOutput>;
  kill(signal?: number): Promise<unknown>;
  resize(cols: number, rows: number): Promise<unknown>;
  dispose(reason?: WorkspaceModuleScopeEnd["reason"]): Promise<void>;
}

function asProc(object: HostObject, context = makeContext()): Proc {
  const member = (name: string): CodemodeMember => {
    const found = codemodeMember(object[name]);
    if (found === undefined) throw new Error(`no member ${name}`);
    return found;
  };
  const value = (name: string) => (member(name) as { value: unknown }).value;
  const lazy = <T>(name: string, kind: "readable" | "writable") => {
    const m = codemodeMember(object[name]) as
      | { open?: (ctx: unknown) => Promise<T> | T }
      | undefined;
    const opener = m?.open;
    if (opener === undefined) return null;
    // Opened on first use, as the isolate's streams are: a stream that wraps the host's. A cancel
    // before any read opens it first, as the bridge does, so the host stream hears of it.
    if (kind === "readable") {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const open = async () =>
        (reader ??= ((await opener(context)) as ReadableStream<Uint8Array>).getReader());
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const { value: chunk, done } = await (await open()).read();
            if (done) controller.close();
            else controller.enqueue(chunk);
          },
          cancel: async (reason) => (await open()).cancel(reason),
        },
        { highWaterMark: 0 },
      ) as unknown as T;
    }
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    const open = async () =>
      (writer ??= ((await opener(context)) as WritableStream<Uint8Array>).getWriter());
    return new WritableStream<Uint8Array>({
      write: async (chunk) => (await open()).write(chunk),
      close: async () => (await open()).close(),
    }) as unknown as T;
  };
  let exitCode: Promise<number> | undefined;
  const method =
    (name: string) =>
    (...args: unknown[]) =>
      (object[name] as (args: unknown[], ctx: WorkspaceModuleCallContext) => Promise<unknown>)(
        args,
        context,
      );
  return {
    pid: value("pid") as number,
    isPty: value("isPty") as boolean,
    stdin: lazy("stdin", "writable"),
    stdout: lazy("stdout", "readable"),
    stderr: lazy("stderr", "readable"),
    get exitCode() {
      exitCode ??= Promise.resolve(
        (member("exitCode") as { settle: (ctx: unknown) => unknown }).settle(context),
      ) as Promise<number>;
      return exitCode;
    },
    output: method("output") as () => Promise<RemoteExecOutput>,
    kill: (signal?: number) => method("kill")(signal ?? null),
    resize: (cols, rows) => method("resize")(cols, rows),
    dispose: async (reason = "completed") => {
      await (object[Symbol.asyncDispose] as (end: unknown) => Promise<void>)({ reason });
    },
  };
}

async function exec(
  argv: unknown,
  options?: unknown,
  extra: {
    module?: Partial<ExecModuleOptions>;
    context?: Partial<WorkspaceModuleCallContext>;
  } = {},
): Promise<Proc> {
  const definition = definitionOf(extra.module);
  const context = makeContext(extra.context);
  const object = await definition.functions.exec?.(
    [argv, options ?? null] as WorkspaceRuntimeValue[],
    context,
  );
  return asProc(object as unknown as HostObject, context);
}

const text = (buffer: ArrayBuffer) => new TextDecoder().decode(buffer);
const encoder = new TextEncoder();

describe("codemode:exec", () => {
  it("pushes, runs and pulls, and output() gives the bytes, exit code and sync reports", async () => {
    await write(h.ws, { "src/in.txt": "hello" });
    const proc = await exec(
      [
        "sh",
        "-c",
        'cat src/in.txt; read x; echo "stdin=$x"; echo $GREETING; mkdir -p out; echo made > out/f; echo err >&2; exit 2',
      ],
      {
        push: ["src/**"],
        pull: ["out/**"],
        stdin: new Blob(["piped\n"]).stream(),
        env: { GREETING: "hi" },
        cwd: "/workspace",
      },
    );
    expect(proc.pid).toBeGreaterThan(1);
    expect(proc.isPty).toBe(false);
    // A stream given as stdin is the command's: no writable stdin, as on the platform.
    expect(proc.stdin).toBeNull();
    const out = await proc.output();
    expect(out.stdout).toBeInstanceOf(ArrayBuffer);
    expect([text(out.stdout), text(out.stderr), out.exitCode]).toEqual([
      "hellostdin=piped\nhi\n",
      "err\n",
      2,
    ]);
    expect(out.sync.pushed).toMatchObject({ status: "done", files: 1, transferred: 1 });
    expect(out.sync.pulled).toMatchObject({ status: "done", files: 1 });
    expect(out.truncated).toBeUndefined();
    expect(await fsp.readFile(path.join(h.ws, "out/f"), "utf8")).toBe("made\n");
  });

  it("output() follows the Workspace's output settings: tail kept, full output saved", async () => {
    const proc = await exec(["seq", "1", "1000"], undefined, {
      module: { output: { maxLines: 5, dir: "/workspace/.out" } },
    });
    const out = await proc.output();
    expect(text(out.stdout)).toBe("996\n997\n998\n999\n1000\n");
    expect(out.truncated?.stdout).toMatchObject({
      status: "saved",
      totalLines: 1000,
      firstLine: 996,
    });
    const saved = (out.truncated?.stdout as { path?: string } | undefined)?.path ?? "";
    expect(saved).toMatch(/^\/workspace\/\.out\/x.+\.stdout\.log$/);
    expect(
      (await fsp.readFile(path.join(h.ws, saved.slice("/workspace/".length)), "utf8")).split("\n"),
    ).toHaveLength(1001);
  });

  it("streams stdin, stdout and stderr, and resolves exitCode", async () => {
    const proc = await exec(["sh", "-c", 'while read l; do echo "got $l"; done; echo done >&2'], {
      stdin: "pipe",
    });
    const writer = proc.stdin?.getWriter();
    await writer?.write(encoder.encode("a\nb\n"));
    await writer?.close();
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exitCode,
    ]);
    expect([out, err, code]).toEqual(["got a\ngot b\n", "done\n", 0]);
  });

  it("streams large output with backpressure", async () => {
    const proc = await exec(["sh", "-c", "head -c 3000000 /dev/zero | tr '\\0' a"]);
    let total = 0;
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) total += chunk.byteLength;
    expect(total).toBe(3_000_000);
    expect(await proc.exitCode).toBe(0);
  });

  it("output() can be called once, only before the streams are read, and takes them", async () => {
    const proc = await exec(["printf", "a\\000b\\377"]);
    const out = await proc.output();
    expect(Array.from(new Uint8Array(out.stdout))).toEqual([97, 0, 98, 255]);
    await expect(proc.output()).rejects.toThrow(/only be called once/);
    // The pipes are output()'s now.
    const stdout = proc.stdout;
    if (stdout === null) throw new Error("stdout is piped");
    await expect(stdout.getReader().read()).rejects.toThrow(/already read stdout/);

    const streamed = await exec(["echo", "x"]);
    expect(await new Response(streamed.stdout).text()).toBe("x\n");
    await expect(streamed.output()).rejects.toThrow(/once either has been read/);
  });

  // "combined" needs the platform's exec(); the example's end-to-end tests cover it.
  it("an ignored stream is null, and empty in output()", async () => {
    const ignored = await exec(["sh", "-c", "echo out; echo err >&2"], { stdout: "ignore" });
    expect(ignored.stdout).toBeNull();
    expect(ignored.stderr).not.toBeNull();
    const out = await ignored.output();
    expect([out.stdout.byteLength, text(out.stderr)]).toEqual([0, "err\n"]);
  });

  it("exitCode resolves after the pull, so the files are already in the workspace", async () => {
    const proc = await exec(["sh", "-c", "echo made > result.txt"], { pull: ["result.txt"] });
    await proc.stdout?.cancel();
    await proc.stderr?.cancel();
    expect(await proc.exitCode).toBe(0);
    expect(await fsp.readFile(path.join(h.ws, "result.txt"), "utf8")).toBe("made\n");
  });

  it("kill() signals the command, and checks its range", async () => {
    const proc = await exec(["sleep", "100"], { stdout: "ignore", stderr: "ignore" });
    await expect(proc.kill(0)).rejects.toThrow(RangeError);
    await expect(proc.kill(65)).rejects.toThrow(RangeError);
    await proc.kill(2);
    expect(await proc.exitCode).toBe(130);
    await expect(proc.resize(80, 24)).rejects.toThrow(/no pty/);
  });

  it("signal: an abort kills the command and skips the pull; an aborted one starts nothing", async () => {
    const controller = new AbortController();
    const proc = await exec(["sleep", "100"], {
      signal: controller.signal,
      pull: ["**"],
      stdout: "ignore",
      stderr: "ignore",
    });
    setTimeout(() => controller.abort(), 200);
    const out = await proc.output();
    expect(out.exitCode).toBe(137);
    expect(out.sync.pulled.status).toBe("skipped");

    const spawned = h.target.children.length;
    await expect(exec(["true"], { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(h.target.children.length).toBe(spawned);
  });

  for (const reason of ["paused", "completed", "disposed"] as const) {
    it(`kills a command still running when its scope ends (${reason}), and forgets it`, async () => {
      const proc = await exec(["sleep", "100"], {
        pull: ["**"],
        stdout: "ignore",
        stderr: "ignore",
      });
      const exited = proc.exitCode;
      await proc.dispose(reason);
      expect(await exited).toBe(137);
      await expect(proc.output()).rejects.toThrow(/no longer running here/);
    });
  }

  it("validates everything code sends", async () => {
    for (const [args, message] of [
      [[undefined], /argv/],
      [[[]], /argv/],
      [["ls"], /argv/],
      [[["ls", 3]], /argv/],
      [[["ls"], "opts"], /options must be an object/],
      [[["ls"], { nope: 1 }], /unknown option "nope"/],
      [[["ls"], { env: { A: 1 } }], /env "A" must be a string/],
      [[["ls"], { stdin: "text" }], /stdin must be "pipe" or a ReadableStream/],
      [[["ls"], { stdout: "file" }], /stdout must be one of/],
      [[["ls"], { push: "src/**" }], /push must be an array/],
      [[["ls"], { user: "root" }], /numeric/],
      [[["ls"], { pull: ["/etc/**"] }], /outside/],
      [[["ls"], { pty: true }], /no pty/],
      [[["ls"], { signal: "stop" }], /signal must be an AbortSignal/],
    ] as [unknown[], RegExp][]) {
      await expect(exec(args[0], args[1]), JSON.stringify(args)).rejects.toThrow(message);
    }
    await expect(exec(["true"], undefined, { context: { access: "read" } })).rejects.toThrow(
      /write access/,
    );
  });

  it("read-only: refuses pull and user before starting anything", async () => {
    const readOnly = { module: { readOnly: true }, context: { access: "read" as const } };
    await expect(exec(["true"], { pull: ["**"] }, readOnly)).rejects.toThrow(
      /can only read files, so it can't pull/,
    );
    await expect(exec(["true"], { user: "0:0" }, readOnly)).rejects.toThrow(
      /run as nobody \(65534:65534\) and it can't choose a user/,
    );
    expect(h.target.children).toHaveLength(0);
  });

  // Switching user needs root, which CI's images don't run as.
  it.skipIf(process.getuid?.() !== 0)(
    "read-only: runs as nobody, pushed files stay root's, and long output is still saved",
    async () => {
      await write(h.ws, { "a.txt": "x" });
      await fsp.chmod(h.base, 0o755);
      const readOnly = {
        module: { readOnly: true, output: { maxLines: 5, dir: "/workspace/.out" } },
        context: { access: "read" as const },
      };
      const proc = await exec(
        ["sh", "-c", "id -u; id -g; stat -c %u:%g a.txt; echo changed > a.txt"],
        { push: ["a.txt"] },
        readOnly,
      );
      const out = await proc.output();
      expect(text(out.stdout).trim().split("\n")).toEqual(["65534", "65534", "0:0"]);
      expect(text(out.stderr)).toMatch(/Permission denied/);
      expect(out.exitCode).not.toBe(0);
      const long = await (await exec(["seq", "1", "1000"], undefined, readOnly)).output();
      expect(long.truncated?.stdout).toMatchObject({ status: "saved", totalLines: 1000 });
    },
  );

  it("installs the bundled binary once, then reuses it", async () => {
    const definition = definitionOf({ agentPath: path.join(h.base, "bin/remote-exec") });
    for (const word of ["one", "two"]) {
      const object = await definition.functions.exec?.([["echo", word]], makeContext());
      expect(text((await asProc(object as unknown as HostObject).output()).stdout)).toBe(
        `${word}\n`,
      );
    }
    const installs = h.target.children.filter(
      ({ cmd }) => cmd[0] === "sh" && cmd[2]?.includes("mv -f"),
    );
    expect(installs).toHaveLength(1);
  });

  it("describes itself for the model", () => {
    const description = createExecModule(moduleOptions()).description ?? "";
    expect(description).toMatch(/push/);
    expect(description).toMatch(/output\(\)/);
    expect(description).toMatch(/blocks the command/);
  });
});

describe("codemode:exec through the bridge", () => {
  // Entries by name and arguments; a restart replays them. As in the bridge's own tests.
  function memoryJournal() {
    const entries: Array<{ key: string; seq: number; response?: string }> = [];
    let next = 1;
    let consumed = new Set<number>();
    const journal: BridgeJournal = {
      begin(name, args) {
        const key = `${name}(${encodeValue(args)})`;
        const entry = entries.find((item) => !consumed.has(item.seq) && item.key === key);
        if (entry !== undefined) {
          consumed.add(entry.seq);
          if (entry.response !== undefined) {
            return {
              kind: "replay",
              response: decodeValue(entry.response) as BridgeResponse,
              at: 0,
              ordinal: entry.seq,
            };
          }
          return { kind: "live", seq: entry.seq, rerun: true };
        }
        const seq = next++;
        entries.push({ key, seq });
        consumed.add(seq);
        return { kind: "live", seq, rerun: false };
      },
      commit(seq, response) {
        const entry = entries.find((item) => item.seq === seq);
        if (entry !== undefined) entry.response = encodeValue(response);
        return { at: 0, ordinal: seq };
      },
      interrupt: () => 0,
      record: () => undefined,
      diverged: () => undefined,
      stalled: () => undefined,
    };
    return { journal, restart: () => void (consumed = new Set()) };
  }

  const bridgeFor = (definition: ReturnType<typeof definitionOf>, journal: BridgeJournal) =>
    new WorkspaceRuntimeBridge({ access: "read-write" } as WorkspaceRuntimeCapability, {
      codemodeModules: new Map([["codemode:exec", { definition, connection: new Map() }]]),
      execution: { id: "run1", metadata: {} },
      journal,
    });

  const result = (response: BridgeResponse) => {
    if ("error" in response) throw new Error(response.error.message);
    return response.result;
  };

  it("replays a command and its output without starting anything, then says it's gone", async () => {
    const memory = memoryJournal();
    const first = bridgeFor(definitionOf(), memory.journal);
    const spawned = await first.call("host/codemode:exec.exec", [["echo", "replayed"], null]);
    const ref = "objects" in spawned ? spawned.objects?.[0]?.ref : undefined;
    expect(spawned).toMatchObject({ objects: [{ fields: { isPty: false, stdin: null } }] });
    const read = async (bridge: WorkspaceRuntimeBridge) => {
      let out = "";
      for (;;) {
        const answer = result(await bridge.call(`host/${ref}.@read:stdout`, [])) as {
          chunk?: Uint8Array;
          done?: true;
        };
        if (answer.done) return out;
        if (answer.chunk) out += new TextDecoder().decode(answer.chunk);
      }
    };
    expect(await read(first)).toBe("replayed\n");
    const children = h.target.children.length;

    // The Durable Object restarted: a new module, which never started the command.
    memory.restart();
    const second = bridgeFor(definitionOf(), memory.journal);
    await second.call("host/codemode:exec.exec", [["echo", "replayed"], null]);
    expect(await read(second)).toBe("replayed\n");
    expect(h.target.children.length).toBe(children);
    // Past what the journal holds, the call is live, and this scope never had the command.
    const live = await second.call(`host/${ref}.@await:exitCode`, []);
    expect("error" in live && live.error.message).toMatch(/no longer running here/);
  });
});
