import { describe, expect, it } from "vitest";

import { type BridgeJournal, type BridgeResponse, WorkspaceRuntimeBridge } from "./bridge";
import type { WorkspaceRuntimeCapability } from "./capability";
import {
  codemodeModuleDefinition,
  createCodemodeModule,
  type WorkspaceModuleScopeEnd,
} from "./codemode-module";
import { unsafeToRepeat } from "./replay-safety";

const OBJECT_MARKER = "\u0000codemode";

// A journal that behaves like ExecutionJournal: entries are found by
// name and arguments, responses are stored as JSON, and a new attempt
// replays what the last one committed.
function memoryJournal() {
  const entries: Array<{ key: string; seq: number; response?: string }> = [];
  let next = 1;
  let consumed = new Set<number>();
  const journal: BridgeJournal = {
    begin(name, args) {
      const key = `${name}(${JSON.stringify(args)})`;
      const entry = entries.find((item) => !consumed.has(item.seq) && item.key === key);
      if (entry !== undefined) {
        consumed.add(entry.seq);
        if (entry.response !== undefined) {
          return {
            kind: "replay",
            response: JSON.parse(entry.response) as BridgeResponse,
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
      if (entry !== undefined) entry.response = JSON.stringify(response);
      return { at: 0, ordinal: seq };
    },
    interrupt: () => 0,
    record: () => undefined,
    diverged: () => undefined,
    stalled: () => undefined,
  };
  return {
    journal,
    entries,
    // A new attempt: every entry can be replayed again.
    restart() {
      consumed = new Set();
    },
  };
}

function jobsModule() {
  const events: string[] = [];
  const jobs = createCodemodeModule();
  const Run = jobs.define("Run", ({ id }: { id: string }) => ({
    wait: async () => {
      events.push(`wait ${id}`);
      return { id, status: "done" };
    },
    charge: unsafeToRepeat(async () => {
      events.push(`charge ${id}`);
      return "charged";
    }),
    [Symbol.asyncDispose]: async (end: WorkspaceModuleScopeEnd) => {
      events.push(`dispose ${id} ${end.reason}`);
    },
  }));
  const Job = jobs.define("Job", ({ id }: { id: string }) => ({
    start: async ([ref]: readonly unknown[]) => {
      events.push(`start ${id}`);
      return Run({ id: `${id}/${String(ref)}` });
    },
  }));
  jobs.context("api", () => "unused: the test passes connection values");
  jobs.context("session", () => "unused", { scoped: true });
  const other = createCodemodeModule();
  const Other = other.define("Other", () => ({ go: async () => null }));
  const module = jobs.module({
    createJob: async ([name]) => {
      events.push(`create ${String(name)}`);
      return Job({ id: String(name) });
    },
    both: async () => ({ jobs: [Job({ id: "a" }), Job({ id: "b" })] }),
    whoami: async (_args, ctx) => ({ api: (ctx as unknown as { api: string }).api }),
    session: async (_args, ctx) => ({
      session: await (ctx as unknown as { session: Promise<string> }).session,
    }),
    idle: async () => "idle",
    foreign: async () => Other({}),
    callback: async ([fn]) => typeof fn,
    stream: async () => new ReadableStream() as never,
  });
  return { events, module };
}

function setup(options: { journal?: BridgeJournal } = {}) {
  const { events, module } = jobsModule();
  const scopedStarts: string[] = [];
  const tracked = new Map<string, (end: WorkspaceModuleScopeEnd) => Promise<void>>();
  const definition = codemodeModuleDefinition(module);
  if (definition === undefined) throw new Error("not a codemode module");
  const bridge = new WorkspaceRuntimeBridge(
    { access: "read-write" } as WorkspaceRuntimeCapability,
    {
      codemodeModules: new Map([
        [
          "codemode:jobs",
          { definition, connection: new Map<string, unknown>([["api", "client"]]) },
        ],
      ]),
      scopedContext: async (specifier, name) => {
        scopedStarts.push(`${specifier} ${name}`);
        return "session-1";
      },
      trackDisposable: (key, close) => void tracked.set(key, close),
      untrackDisposable: (key) => void tracked.delete(key),
      execution: { id: "exec-1", metadata: {} },
      maxPayloadBytes: 4096,
      ...(options.journal === undefined ? {} : { journal: options.journal }),
    },
  );
  return { bridge, events, scopedStarts, tracked };
}

function result(response: BridgeResponse) {
  if ("error" in response) throw new Error(`call failed: ${response.error.message}`);
  return response.result;
}

function errorOf(response: BridgeResponse) {
  return "error" in response ? response.error.message : undefined;
}

describe("WorkspaceRuntimeBridge codemode modules", () => {
  it("returns a defined object as a marker and an objects entry, without its state", async () => {
    const { bridge } = setup();
    const response = await bridge.call("host/codemode:jobs.createJob", ["build"]);
    expect(result(response)).toEqual({ [OBJECT_MARKER]: 0 });
    expect(response).toMatchObject({ objects: [{ ref: "codemode:jobs#c1:0", kind: "Job" }] });
    expect(JSON.stringify(response)).not.toContain("build");
  });

  it("gives each object in a result its own ref", async () => {
    const { bridge } = setup();
    const response = await bridge.call("host/codemode:jobs.both", []);
    expect(result(response)).toEqual({ jobs: [{ [OBJECT_MARKER]: 0 }, { [OBJECT_MARKER]: 1 }] });
    expect(response).toMatchObject({
      objects: [
        { ref: "codemode:jobs#c1:0", kind: "Job" },
        { ref: "codemode:jobs#c1:1", kind: "Job" },
      ],
    });
  });

  it("runs a method on an object by its ref", async () => {
    const { bridge, events } = setup();
    await bridge.call("host/codemode:jobs.createJob", ["build"]);
    const response = await bridge.call("host/codemode:jobs#c1:0.start", ["main"]);
    expect(result(response)).toEqual({ [OBJECT_MARKER]: 0 });
    expect(response).toMatchObject({ objects: [{ ref: "codemode:jobs#c2:0", kind: "Run" }] });
    expect(events).toEqual(["create build", "start build"]);
  });

  it("refuses a ref it didn't issue, and a method the object doesn't have", async () => {
    const { bridge } = setup();
    expect(errorOf(await bridge.call("host/codemode:jobs#c9:0.start", ["x"]))).toMatch(
      /Unknown codemode object/,
    );
    const created = await bridge.call("host/codemode:jobs.createJob", ["build"]);
    const ref = "objects" in created ? created.objects?.[0]?.ref : undefined;
    expect(errorOf(await bridge.call(`host/${ref}.toString`, []))).toMatch(
      /Unknown Workspace host module call/,
    );
  });

  it("refuses an object from another module", async () => {
    const { bridge } = setup();
    expect(errorOf(await bridge.call("host/codemode:jobs.foreign", []))).toMatch(/another module/);
  });

  it("gives functions their connection context in ctx", async () => {
    const { bridge } = setup();
    expect(result(await bridge.call("host/codemode:jobs.whoami", []))).toEqual({ api: "client" });
  });

  it("starts a scoped context only when a method reads it", async () => {
    const { bridge, scopedStarts } = setup();
    await bridge.call("host/codemode:jobs.idle", []);
    expect(scopedStarts).toEqual([]);
    expect(result(await bridge.call("host/codemode:jobs.session", []))).toEqual({
      session: "session-1",
    });
    expect(scopedStarts).toEqual(["codemode:jobs session"]);
  });

  it("uses journal sequence numbers for refs in a journaled run", async () => {
    const { journal } = memoryJournal();
    const { bridge } = setup({ journal });
    const response = await bridge.call("host/codemode:jobs.createJob", ["build"]);
    expect(response).toMatchObject({ objects: [{ ref: "codemode:jobs#1:0", kind: "Job" }] });
  });

  it("journals an object's state, and replays it without running anything", async () => {
    const memory = memoryJournal();
    const first = setup({ journal: memory.journal });
    await first.bridge.call("host/codemode:jobs.createJob", ["build"]);
    await first.bridge.call("host/codemode:jobs#1:0.start", ["main"]);
    expect(memory.entries[0]?.response).toContain('"state":{"id":"build"}');

    memory.restart();
    const second = setup({ journal: memory.journal });
    const created = await second.bridge.call("host/codemode:jobs.createJob", ["build"]);
    const started = await second.bridge.call("host/codemode:jobs#1:0.start", ["main"]);
    expect(created).toMatchObject({ objects: [{ ref: "codemode:jobs#1:0", kind: "Job" }] });
    expect(started).toMatchObject({ objects: [{ ref: "codemode:jobs#2:0", kind: "Run" }] });
    expect(JSON.stringify(created)).not.toContain("state");
    expect(second.events).toEqual([]);
  });

  it("rebuilds a replayed object from its state for a live call", async () => {
    const memory = memoryJournal();
    const first = setup({ journal: memory.journal });
    await first.bridge.call("host/codemode:jobs.createJob", ["build"]);
    await first.bridge.call("host/codemode:jobs#1:0.start", ["main"]);

    memory.restart();
    const second = setup({ journal: memory.journal });
    await second.bridge.call("host/codemode:jobs.createJob", ["build"]);
    await second.bridge.call("host/codemode:jobs#1:0.start", ["main"]);
    expect(result(await second.bridge.call("host/codemode:jobs#2:0.wait", []))).toEqual({
      id: "build/main",
      status: "done",
    });
    expect(second.events).toEqual(["wait build/main"]);
  });

  it("won't run an unsafe object method again after an interruption", async () => {
    const memory = memoryJournal();
    const first = setup({ journal: memory.journal });
    await first.bridge.call("host/codemode:jobs.createJob", ["build"]);
    await first.bridge.call("host/codemode:jobs#1:0.start", ["main"]);
    // The charge began but its response was never journaled.
    memory.journal.begin("host/codemode:jobs#2:0.charge", []);

    memory.restart();
    const second = setup({ journal: memory.journal });
    await second.bridge.call("host/codemode:jobs.createJob", ["build"]);
    await second.bridge.call("host/codemode:jobs#1:0.start", ["main"]);
    expect(errorOf(await second.bridge.call("host/codemode:jobs#2:0.charge", []))).toMatch(
      /isn't safe to repeat/,
    );
    expect(second.events).toEqual([]);
  });

  it("refuses callbacks and opaque results in a replayable run", async () => {
    const { bridge } = setup({ journal: memoryJournal().journal });
    expect(errorOf(await bridge.call("host/codemode:jobs.callback", [() => 1]))).toMatch(
      /replayable run/,
    );
    expect(errorOf(await bridge.call("host/codemode:jobs.stream", []))).toMatch(/JSON-compatible/);
  });

  it("passes callbacks and opaque results through in a run that doesn't replay", async () => {
    const { bridge } = setup();
    expect(result(await bridge.call("host/codemode:jobs.callback", [() => 1]))).toBe("function");
    expect(result(await bridge.call("host/codemode:jobs.stream", []))).toBeInstanceOf(
      ReadableStream,
    );
  });

  it("tracks live objects that have a disposer, and disposes one when code releases it", async () => {
    const { bridge, events, tracked } = setup();
    await bridge.call("host/codemode:jobs.createJob", ["build"]);
    expect([...tracked.keys()]).toEqual([]);
    await bridge.call("host/codemode:jobs#c1:0.start", ["main"]);
    expect([...tracked.keys()]).toEqual(["object:codemode:jobs#c2:0"]);

    await bridge.release("codemode:jobs#c2:0");
    expect(events).toContain("dispose build/main disposed");
    expect([...tracked.keys()]).toEqual([]);
    expect(errorOf(await bridge.call("host/codemode:jobs#c2:0.wait", []))).toMatch(
      /Unknown codemode object/,
    );
  });

  it("ignores a release for a ref it doesn't know", async () => {
    const { bridge } = setup();
    await expect(bridge.release("codemode:jobs#c7:0")).resolves.toBeUndefined();
  });
});
