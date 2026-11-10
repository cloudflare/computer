/**
 * A codemode object's members that aren't methods, through the bridge: fields, promises that
 * outlast a call, byte streams in both directions, and streams passed as arguments in a
 * replayable run. Each runs as it would in a run that doesn't replay, and in one that does, with
 * a journal that answers a second attempt from the first.
 */
import { describe, expect, it } from "vitest";

import { decodeValue, encodeValue } from "../backends/codemode/journal";

import {
  type BridgeJournal,
  type BridgeResponse,
  CODEMODE_SIGNAL_MARKER,
  CODEMODE_STREAM_MARKER,
  WorkspaceRuntimeBridge,
} from "./bridge";
import type { WorkspaceRuntimeCapability } from "./capability";
import {
  codemodeModuleDefinition,
  createCodemodeModule,
  field,
  promised,
  readable,
  writable,
  type WorkspaceModuleScopeEnd,
} from "./codemode-module";

const OBJECT_MARKER = "\u0000codemode";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// As in bridge-codemode.test.ts: entries found by name and arguments, a restart replays them.
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
  return {
    journal,
    restart() {
      consumed = new Set();
    },
  };
}

/**
 * A process-like object: `pid` a field, `exitCode` a promise that settles when `exit()` is
 * called, `stdout` a stream of what `emit()` sends, `stdin` a stream into `received`.
 */
function processes() {
  const events: string[] = [];
  const held: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const procs = new Map<
    string,
    {
      exit: (code: number) => void;
      exited: Promise<number>;
      out: ReadableStreamDefaultController<Uint8Array>;
      outStream: ReadableStream<Uint8Array>;
      received: string[];
      inStream: WritableStream<Uint8Array>;
      inRoom?: () => void;
    }
  >();
  const make = (id: string, options: { slowSink?: boolean } = {}) => {
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => (exit = resolve));
    let out!: ReadableStreamDefaultController<Uint8Array>;
    const outStream = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          out = c;
        },
        cancel: (reason) => void events.push(`stdout cancelled ${String(reason)}`),
      },
      { highWaterMark: 0 },
    );
    const entry = {
      exit,
      exited,
      out,
      outStream,
      received: [] as string[],
      inStream: undefined as unknown as WritableStream<Uint8Array>,
      inRoom: undefined as (() => void) | undefined,
    };
    entry.inStream = new WritableStream<Uint8Array>(
      {
        write: async (chunk) => {
          entry.received.push(decoder.decode(chunk));
          // A slow sink holds each write until `drain()`.
          if (options.slowSink) await new Promise<void>((resolve) => (entry.inRoom = resolve));
        },
        close: () => void events.push("stdin closed"),
        abort: (reason) => void events.push(`stdin aborted ${String(reason)}`),
      },
      { highWaterMark: 1 },
    );
    procs.set(id, entry);
    return entry;
  };

  const module = createCodemodeModule();
  const Proc = module.define("Proc", ({ id, pid }: { id: string; pid: number }) => ({
    pid: field(pid),
    label: field({ id, bytes: new Uint8Array([1, 2]) }),
    exitCode: promised(async () => {
      events.push(`settle ${id}`);
      const proc = procs.get(id);
      if (proc === undefined) throw new Error(`process ${id} is gone`);
      return proc.exited;
    }),
    stdout: readable(() => {
      events.push(`open stdout ${id}`);
      const proc = procs.get(id);
      if (proc === undefined) throw new Error(`process ${id} is gone`);
      return proc.outStream;
    }),
    stdin: writable(() => {
      events.push(`open stdin ${id}`);
      const proc = procs.get(id);
      if (proc === undefined) throw new Error(`process ${id} is gone`);
      return proc.inStream;
    }),
    kill: async () => {
      events.push(`kill ${id}`);
      return null;
    },
    [Symbol.asyncDispose]: async (end: WorkspaceModuleScopeEnd) => {
      events.push(`dispose ${id} ${end.reason}`);
    },
  }));
  const definition = codemodeModuleDefinition(
    module.module({
      spawn: async ([id, options]) => {
        events.push(`spawn ${String(id)}`);
        make(String(id), (options ?? {}) as { slowSink?: boolean });
        return Proc({ id: String(id), pid: 4242 });
      },
      // Reads a stream argument to its end, as text.
      upload: async ([stream]) => {
        events.push("upload");
        return await new Response(stream as unknown as ReadableStream).text();
      },
      // Takes a stream and never reads it.
      ignore: async () => "ignored",
      // Takes a stream's reader and returns, leaving the test to read it.
      hold: async ([stream]) => {
        held.push((stream as unknown as ReadableStream<Uint8Array>).getReader());
        return "held";
      },
      // What the function was given.
      kindOf: async ([value]) => (value instanceof ReadableStream ? "stream" : typeof value),
      // Settles once its signal aborts, with the reason.
      whenAborted: async ([options]) => {
        const { signal } = options as unknown as { signal: AbortSignal };
        if (!(signal instanceof AbortSignal)) return "not a signal";
        if (!signal.aborted) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        }
        const reason = signal.reason as Error;
        return `${reason.name}: ${reason.message}`;
      },
    }),
  );
  if (definition === undefined) throw new Error("not a codemode module");
  return { events, procs, definition, held };
}

function setup(
  options: {
    journal?: BridgeJournal;
    maxPayloadBytes?: number;
    maxCallDurationMs?: number;
    maxCalls?: number;
    maxTotalResponseBytes?: number;
    maxStreamBytes?: number;
    shared?: ReturnType<typeof processes>;
  } = {},
) {
  const shared = options.shared ?? processes();
  const bridge = new WorkspaceRuntimeBridge(
    { access: "read-write" } as WorkspaceRuntimeCapability,
    {
      codemodeModules: new Map([
        ["codemode:proc", { definition: shared.definition, connection: new Map() }],
      ]),
      trackDisposable: () => undefined,
      untrackDisposable: () => undefined,
      execution: { id: "exec-1", metadata: {} },
      maxPayloadBytes: options.maxPayloadBytes ?? 4096,
      ...(options.maxCallDurationMs === undefined
        ? {}
        : { maxCallDurationMs: options.maxCallDurationMs }),
      ...(options.maxCalls === undefined ? {} : { maxCalls: options.maxCalls }),
      ...(options.maxTotalResponseBytes === undefined
        ? {}
        : { maxTotalResponseBytes: options.maxTotalResponseBytes }),
      ...(options.maxStreamBytes === undefined ? {} : { maxStreamBytes: options.maxStreamBytes }),
      ...(options.journal === undefined ? {} : { journal: options.journal }),
    },
  );
  return { bridge, ...shared };
}

function result(response: BridgeResponse) {
  if ("error" in response) throw new Error(`call failed: ${response.error.message}`);
  return response.result;
}

function errorOf(response: BridgeResponse) {
  return "error" in response ? response.error.message : undefined;
}

async function spawn(bridge: WorkspaceRuntimeBridge, id = "p1", options?: object) {
  const response = await bridge.call("host/codemode:proc.spawn", [id, options ?? null]);
  const ref = "objects" in response ? response.objects?.[0]?.ref : undefined;
  if (ref === undefined) throw new Error(`no object: ${JSON.stringify(response)}`);
  return { response, at: (op: string) => `host/${ref}.${op}` };
}

/** Calls `name` until it stops answering `again`, as the isolate does. */
async function settle(bridge: WorkspaceRuntimeBridge, name: string, args: unknown[] = []) {
  for (;;) {
    const answer = result(await bridge.call(name, args)) as Record<string, unknown> | null;
    if (answer?.again !== true && answer?.done !== false) return answer;
  }
}

describe("codemode object members", () => {
  it("sends fields and member kinds with the object, and keeps neither from the journal", async () => {
    const memory = memoryJournal();
    const live = await spawn(setup().bridge);
    expect(result(live.response)).toEqual({ [OBJECT_MARKER]: 0 });
    expect(live.response).toMatchObject({
      objects: [
        {
          kind: "Proc",
          fields: { pid: 4242, label: { id: "p1", bytes: new Uint8Array([1, 2]) } },
          members: { exitCode: "promise", stdout: "readable", stdin: "writable" },
        },
      ],
    });
    // A method isn't a member, and the isolate never sees the state.
    expect(JSON.stringify(live.response)).not.toContain('"state"');
    expect(JSON.stringify(live.response)).not.toContain("kill");

    const first = setup({ journal: memory.journal });
    await spawn(first.bridge);
    memory.restart();
    const second = setup({ journal: memory.journal });
    const replayed = await spawn(second.bridge);
    expect(replayed.response).toMatchObject({
      objects: [{ fields: { pid: 4242 }, members: { exitCode: "promise" } }],
    });
    expect(second.events).toEqual([]);
  });

  it("waits for a promise across as many calls as it takes, settling it once", async () => {
    const { bridge, procs, events } = setup({ maxCallDurationMs: 100 });
    const proc = await spawn(bridge);
    const answers: unknown[] = [];
    const exited = (async () => {
      for (;;) {
        const answer = result(await bridge.call(proc.at("@await:exitCode"), [])) as {
          done: boolean;
        };
        answers.push(answer);
        if (answer.done) return answer;
      }
    })();
    await sleep(350);
    procs.get("p1")?.exit(3);
    expect(await exited).toEqual({ done: true, value: 3 });
    // Each call answered before its 100 ms deadline, with the promise still pending.
    expect(answers.length).toBeGreaterThanOrEqual(3);
    expect(answers.slice(0, -1).every((a) => !(a as { done: boolean }).done)).toBe(true);
    expect(events.filter((e) => e.startsWith("settle"))).toEqual(["settle p1"]);
    // Asked again, it answers at once.
    expect(result(await bridge.call(proc.at("@await:exitCode"), []))).toEqual({
      done: true,
      value: 3,
    });
  });

  it("stops waiting on a promise when the run ends, rather than at the call's deadline", async () => {
    // The default deadline: 30 seconds.
    const { bridge } = setup();
    const proc = await spawn(bridge);
    const waiting = bridge.call(proc.at("@await:exitCode"), []);
    await sleep(20);
    const started = Date.now();
    await bridge.cancelAndDrain();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result(await waiting)).toEqual({ done: false });
  });

  it("rejects a promise as its settle function does", async () => {
    const { bridge, procs } = setup();
    const proc = await spawn(bridge);
    procs.delete("p1");
    expect(errorOf(await bridge.call(proc.at("@await:exitCode"), []))).toBe("process p1 is gone");
  });

  it("streams a readable member only as it's read, splitting chunks too large for one call", async () => {
    const { bridge, procs, events } = setup({ maxPayloadBytes: 1024 });
    const proc = await spawn(bridge);
    expect(events).toEqual(["spawn p1"]);
    const out = procs.get("p1");
    out?.out.enqueue(encoder.encode("hello "));
    out?.out.enqueue(encoder.encode("x".repeat(2500)));
    out?.out.close();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const answer = (await settle(bridge, proc.at("@read:stdout"))) as {
        chunk?: Uint8Array;
        done?: true;
      };
      if (answer.done) break;
      if (answer.chunk) chunks.push(answer.chunk);
    }
    expect(events).toEqual(["spawn p1", "open stdout p1"]);
    expect(chunks.every((c) => c.byteLength <= 1024 - 64)).toBe(true);
    expect(decoder.decode(Buffer.concat(chunks))).toBe(`hello ${"x".repeat(2500)}`);
    expect(errorOf(await bridge.call(proc.at("@read:stdout"), []))).toMatch(/already ended/);
  });

  it("keeps a read waiting past its call's deadline, and loses nothing", async () => {
    const { bridge, procs } = setup({ maxCallDurationMs: 100 });
    const proc = await spawn(bridge);
    const first = result(await bridge.call(proc.at("@read:stdout"), []));
    expect(first).toEqual({ again: true });
    procs.get("p1")?.out.enqueue(encoder.encode("late"));
    expect(result(await bridge.call(proc.at("@read:stdout"), []))).toEqual({
      chunk: encoder.encode("late"),
    });
  });

  it("cancels the host stream when code cancels a readable member", async () => {
    const { bridge, events } = setup({ maxCallDurationMs: 100 });
    const proc = await spawn(bridge);
    // Opens the stream; nothing has been written, so it answers "not yet".
    expect(result(await bridge.call(proc.at("@read:stdout"), []))).toEqual({ again: true });
    expect(result(await bridge.call(proc.at("@cancel:stdout"), ["done reading"]))).toBeNull();
    expect(events).toContain("stdout cancelled done reading");
  });

  it("writes to a writable member in order, with the host stream's backpressure, and closes it", async () => {
    const { bridge, procs, events } = setup({ maxCallDurationMs: 100 });
    const proc = await spawn(bridge, "p1", { slowSink: true });
    expect(result(await bridge.call(proc.at("@write:stdin"), [encoder.encode("a")]))).toEqual({
      ok: true,
    });
    // The sink is still holding "a", which fills the queue, so "b" isn't accepted yet.
    expect(result(await bridge.call(proc.at("@write:stdin"), [encoder.encode("b")]))).toEqual({
      again: true,
    });
    const sink = procs.get("p1");
    expect(sink?.received).toEqual(["a"]);
    const drain = setInterval(() => sink?.inRoom?.(), 10);
    try {
      for (const chunk of ["b", "c"]) {
        expect(await settle(bridge, proc.at("@write:stdin"), [encoder.encode(chunk)])).toEqual({
          ok: true,
        });
      }
      expect(await settle(bridge, proc.at("@close:stdin"))).toEqual({ ok: true });
    } finally {
      clearInterval(drain);
    }
    expect(sink?.received).toEqual(["a", "b", "c"]);
    expect(events).toContain("stdin closed");
    expect(errorOf(await bridge.call(proc.at("@write:stdin"), ["text"]))).toMatch(/takes bytes/);
  });

  it("aborts the host stream when code aborts a writable member", async () => {
    const { bridge, events } = setup();
    const proc = await spawn(bridge);
    expect(result(await bridge.call(proc.at("@abort:stdin"), ["stop"]))).toEqual({ ok: true });
    expect(events).toContain("stdin aborted stop");
  });

  it("refuses an operation on a member of another kind, or one the object doesn't have", async () => {
    const { bridge } = setup();
    const proc = await spawn(bridge);
    expect(errorOf(await bridge.call(proc.at("@read:exitCode"), []))).toMatch(
      /has no readable member "exitCode"/,
    );
    expect(errorOf(await bridge.call(proc.at("@await:nothing"), []))).toMatch(
      /has no promise member "nothing"/,
    );
    // A member isn't a method, and an unknown op isn't a member call.
    expect(errorOf(await bridge.call(proc.at("stdout"), []))).toMatch(/Unknown Workspace host/);
    expect(errorOf(await bridge.call(proc.at("@peek:stdout"), []))).toMatch(
      /Unknown Workspace host/,
    );
  });

  it("doesn't count stream calls against the call and response budgets", async () => {
    const { bridge, procs } = setup({ maxCalls: 3, maxTotalResponseBytes: 2000 });
    const proc = await spawn(bridge);
    const out = procs.get("p1");
    for (let i = 0; i < 20; i++) out?.out.enqueue(encoder.encode("y".repeat(500)));
    out?.out.close();
    let bytes = 0;
    for (;;) {
      const answer = (await settle(bridge, proc.at("@read:stdout"))) as {
        chunk?: Uint8Array;
        done?: true;
      };
      if (answer.done) break;
      bytes += answer.chunk?.byteLength ?? 0;
    }
    expect(bytes).toBe(10_000);
    // The spawn was one of the three calls; two are left for anything else.
    await bridge.call(proc.at("kill"), []);
    await bridge.call(proc.at("kill"), []);
    expect(errorOf(await bridge.call(proc.at("kill"), []))).toMatch(/exceeds 3 capability calls/);
  });

  it("bounds what a replayable run's streams journal by maxStreamBytes", async () => {
    const { bridge, procs } = setup({ journal: memoryJournal().journal, maxStreamBytes: 1500 });
    const proc = await spawn(bridge);
    const out = procs.get("p1");
    for (let i = 0; i < 5; i++) out?.out.enqueue(encoder.encode("z".repeat(500)));
    let failure: string | undefined;
    for (let i = 0; i < 5 && failure === undefined; i++) {
      failure = errorOf(await bridge.call(proc.at("@read:stdout"), []));
    }
    expect(failure).toMatch(/streams exceed 1500 bytes/);
  });

  it("replays a stream's chunks and a promise without opening or settling anything", async () => {
    const memory = memoryJournal();
    const first = setup({ journal: memory.journal });
    const proc = await spawn(first.bridge);
    const out = first.procs.get("p1");
    out?.out.enqueue(encoder.encode("one"));
    out?.out.close();
    first.procs.get("p1")?.exit(0);
    const reads = [
      await first.bridge.call(proc.at("@read:stdout"), []),
      await first.bridge.call(proc.at("@read:stdout"), []),
    ];
    const exit = await first.bridge.call(proc.at("@await:exitCode"), []);

    memory.restart();
    const second = setup({ journal: memory.journal });
    const again = await spawn(second.bridge);
    expect(result(await second.bridge.call(again.at("@read:stdout"), []))).toEqual(
      result(reads[0] as BridgeResponse),
    );
    expect(result(await second.bridge.call(again.at("@read:stdout"), []))).toEqual({ done: true });
    expect(result(await second.bridge.call(again.at("@await:exitCode"), []))).toEqual(result(exit));
    expect(second.events).toEqual([]);
  });

  it("rebuilds an object for a live member call once its journal runs out", async () => {
    const memory = memoryJournal();
    const shared = processes();
    const first = setup({ journal: memory.journal, shared });
    await spawn(first.bridge);
    memory.restart();
    // The run resumes after a restart: its process is gone, so the member says so.
    shared.procs.clear();
    const second = setup({ journal: memory.journal, shared });
    const proc = await spawn(second.bridge);
    expect(errorOf(await second.bridge.call(proc.at("@read:stdout"), []))).toBe(
      "process p1 is gone",
    );
  });

  it("lets go of a member's host stream when code releases the object", async () => {
    const { bridge, events } = setup({ maxCallDurationMs: 100 });
    const proc = await spawn(bridge);
    await bridge.call(proc.at("@read:stdout"), []).catch(() => undefined);
    const ref = proc.at("x").slice("host/".length, -".x".length);
    await bridge.release(ref);
    expect(events).toContain("dispose p1 disposed");
    expect(events.some((e) => e.startsWith("stdout cancelled"))).toBe(true);
  });
});

describe("stream arguments in a replayable run", () => {
  const marker = (id: string) => ({ [CODEMODE_STREAM_MARKER]: id });
  const push = (id: string, chunk: string | null, failure?: string) =>
    failure === undefined
      ? ["stream.push", [id, chunk === null ? null : encoder.encode(chunk)]]
      : ["stream.push", [id, null, failure]];

  it("gives the host function a stream fed by the isolate's pushes", async () => {
    const { bridge } = setup({ journal: memoryJournal().journal });
    const upload = bridge.call("host/codemode:proc.upload", [marker("s1")]);
    for (const [name, args] of [push("s1", "hello "), push("s1", "world"), push("s1", null)]) {
      expect(await settle(bridge, name as string, args as unknown[])).toEqual({ ok: true });
    }
    expect(result(await upload)).toBe("hello world");
  });

  it("holds a push until the host has room for it", async () => {
    const { bridge, held } = setup({ journal: memoryJournal().journal, maxCallDurationMs: 100 });
    expect(result(await bridge.call("host/codemode:proc.hold", [marker("s1")]))).toBe("held");
    const pushOne = (chunk: string) => bridge.call("stream.push", ["s1", encoder.encode(chunk)]);
    // One chunk ahead of its reader at most: the second waits for a read.
    expect(result(await pushOne("a"))).toEqual({ ok: true });
    expect(result(await pushOne("b"))).toEqual({ again: true });
    const reader = held[0];
    expect(decoder.decode((await reader?.read())?.value)).toBe("a");
    expect(result(await pushOne("b"))).toEqual({ ok: true });
    expect(decoder.decode((await reader?.read())?.value)).toBe("b");
  });

  it("fails the host stream when the isolate's stream fails", async () => {
    const { bridge } = setup({ journal: memoryJournal().journal });
    const upload = bridge.call("host/codemode:proc.upload", [marker("s1")]);
    await bridge.call(...(push("s1", null, "disk on fire") as [string, unknown[]]));
    expect(errorOf(await upload)).toBe("disk on fire");
  });

  it("ends a stream the function returned without reading, so the isolate stops pushing", async () => {
    const { bridge } = setup({ journal: memoryJournal().journal });
    expect(result(await bridge.call("host/codemode:proc.ignore", [marker("s1")]))).toBe("ignored");
    expect(result(await bridge.call("stream.push", ["s1", encoder.encode("x")]))).toEqual({
      closed: true,
    });
  });

  it("refuses a push for a stream no call is reading", async () => {
    const { bridge } = setup({ journal: memoryJournal().journal });
    expect(errorOf(await bridge.call("stream.push", ["s9", encoder.encode("x")]))).toMatch(
      /Nothing is reading this stream/,
    );
  });

  it("leaves a marker alone in a run that doesn't replay, where streams cross as they are", async () => {
    expect(result(await setup().bridge.call("host/codemode:proc.kindOf", [marker("s1")]))).toBe(
      "object",
    );
    const replayable = setup({ journal: memoryJournal().journal });
    expect(result(await replayable.bridge.call("host/codemode:proc.kindOf", [marker("s1")]))).toBe(
      "stream",
    );
  });
});

describe("signal arguments, in any run", () => {
  const marker = (id: string) => ({ [CODEMODE_SIGNAL_MARKER]: id });

  for (const journaled of [false, true]) {
    it(`gives the host function a signal its abort call aborts${journaled ? ", journaled" : ""}`, async () => {
      const { bridge } = setup(journaled ? { journal: memoryJournal().journal } : {});
      const waiting = bridge.call("host/codemode:proc.whenAborted", [{ signal: marker("a1") }]);
      await sleep(10);
      expect(result(await bridge.call("signal.abort", ["a1", "stop now"]))).toBeNull();
      expect(result(await waiting)).toBe("AbortError: stop now");
    });
  }

  it("aborts a signal whose abort arrived before the call that takes it", async () => {
    const { bridge } = setup();
    await bridge.call("signal.abort", ["a1"]);
    expect(
      result(await bridge.call("host/codemode:proc.whenAborted", [{ signal: marker("a1") }])),
    ).toBe("AbortError: The operation was aborted");
  });
});

describe("define with members", () => {
  it("refuses a member whose name isn't an identifier", () => {
    const module = createCodemodeModule();
    const Bad = module.define("Bad", () => ({ "a.b": field(1) }));
    expect(() => Bad({})).toThrow(/must be named like a JavaScript identifier/);
  });

  it("refuses members made without a function", () => {
    expect(() => promised(1 as never)).toThrow(/takes a function/);
    expect(() => readable(null as never)).toThrow(/takes a function/);
    expect(() => writable("x" as never)).toThrow(/takes a function/);
  });
});
