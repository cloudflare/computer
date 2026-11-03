import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ShellRPC, SyncRPC } from "@cloudflare/computer-rpc";
import type { WorkspaceBackend } from "../src/backend";
import {
  WorkerJavaScriptBackend,
  type WorkerJavaScriptBackendOptions,
} from "../src/backends/worker-javascript/index";
import { createGitClient } from "../src/git/index";
import type {
  WorkspaceExecutionMetadata,
  WorkspaceRuntimePendingCall,
  WorkspaceRuntimeValue,
  WorkspaceStub,
} from "../src/index";
import {
  createCodemodeModule,
  unsafeToRepeat,
  type WorkspaceModuleScopeEnd,
  Workspace,
} from "../src/index";
import { createArtifactsModule } from "../src/modules/artifacts";
import { createContainerModule } from "../src/modules/container";
import { createGitModule } from "../src/modules/git";

export interface Env {
  HOST: DurableObjectNamespace<HostDO>;
  LOADER: WorkerLoader;
}

// A command backend that stands in for the container. It echoes the
// command, working directory, one environment variable, and standard
// input, and exits with the length of the command.
function fakeContainerBackend(): WorkspaceBackend {
  const encoder = new TextEncoder();
  const shell: ShellRPC = {
    async exec(input) {
      const id = input.id ?? crypto.randomUUID();
      const stdin = input.stdin ? new TextDecoder().decode(input.stdin) : "";
      const stdout = `ran ${input.source} in ${input.cwd ?? "?"} with ${input.env?.WHO ?? "-"} and ${stdin || "-"}\n`;
      return {
        id,
        events: new ReadableStream({
          start(controller) {
            controller.enqueue({ id, seq: 1, name: "stdout", value: encoder.encode(stdout) });
            controller.enqueue({ id, seq: 2, name: "stderr", value: encoder.encode("warn\n") });
            controller.enqueue({ id, seq: 3, name: "exit", code: input.source.length % 256 });
            controller.close();
          },
        }),
      };
    },
    getExec: () => Promise.reject(new Error("not used")),
    killExec: () => Promise.resolve(),
    disposeExec: () => Promise.resolve(),
  };
  // SAFETY: The fake backend declares sync "none", so the Workspace never calls these methods.
  const sync = new Proxy(
    {},
    { get: () => () => Promise.reject(new Error("sync: none")) },
  ) as SyncRPC;
  return {
    id: "container-shell",
    type: "fake-container",
    async connect() {
      return { rpc: { sync, shell }, sync: "none", close: async () => {} };
    },
  };
}

// Durable execution tests restart the object with ctx.abort(). Module
// state outlives the object, so it counts host calls across the restart
// and holds the gate a run waits on until the object restarts.
const durableCalls = new Map<string, number>();
// Each call onWait was told about.
const waits: WorkspaceRuntimePendingCall[] = [];
let gateOpen = false;
// Named gates a run can wait on after the first, for a second restart.
const opened = new Set<string>();
// The execution each executionGate call was told it belongs to.
const executions: Array<{
  id: string;
  metadata: WorkspaceExecutionMetadata;
}> = [];

// What codemode:test-session instances did, and each approve call, in
// order, such as "start 1" or "close paused 1".
const sessionEvents: Array<{ id: string; event: string }> = [];

// How many codemode:test-session instances each execution started.
const sessionCounts = new Map<string, number>();

// Paused closes held until the test lets them go, by execution id.
const heldCloses = new Map<string, () => void>();

function countCall(name: string): number {
  const count = (durableCalls.get(name) ?? 0) + 1;
  durableCalls.set(name, count);
  return count;
}

// Records each scope's session start and close. `use()` reads the
// scoped context, which starts it, and returns the session's number
// within its run. A run's metadata can ask it to hold a paused close
// until /session-release, and to log `closeLog` when the run ends.
const sessionModule = createCodemodeModule();
sessionModule.context(
  "session",
  async ({ id, metadata }) => {
    const instance = (sessionCounts.get(id) ?? 0) + 1;
    sessionCounts.set(id, instance);
    sessionEvents.push({ id, event: `start ${instance}` });
    // Slow enough that a run's concurrent first calls overlap.
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { id, metadata, instance };
  },
  {
    scoped: true,
    async dispose({ id, metadata, instance }, end) {
      sessionEvents.push({ id, event: `close ${end.reason} ${instance}` });
      if (end.reason === "paused" && metadata.holdClose !== undefined) {
        await new Promise<void>((resolve) => heldCloses.set(id, resolve));
        heldCloses.delete(id);
      }
      if (end.reason !== "paused" && end.reason !== "disposed" && metadata.closeLog !== undefined) {
        end.log(`${metadata.closeLog}\n`);
      }
      sessionEvents.push({ id, event: `closed ${instance}` });
    },
  },
);
const testSession = sessionModule.module({
  use: async (_args, ctx) =>
    (await (ctx as unknown as { session: Promise<{ instance: number }> }).session).instance,
});

// Objects: a job that starts runs. Each call counts itself; a run notes
// when it's disposed, under the execution that made it.
const jobsModule = createCodemodeModule({
  description: "Test jobs: `createJob(name)` returns a job whose `start(ref)` returns a run.",
});
const TestRun = jobsModule.define("Run", ({ id, run }: { id: string; run: string }) => ({
  wait: async () => {
    countCall(`wait ${id}`);
    return { id, status: "done" };
  },
  [Symbol.asyncDispose]: async (end: WorkspaceModuleScopeEnd) => {
    sessionEvents.push({ id: run, event: `dispose ${id} ${end.reason}` });
  },
}));
const TestJob = jobsModule.define("Job", ({ id, run }: { id: string; run: string }) => ({
  start: async ([ref]) => {
    countCall(`start ${id}`);
    return TestRun({ id: `${id}/${String(ref)}`, run });
  },
  fail: async () => {
    throw Object.assign(new Error("no such ref"), { code: "ENOREF" });
  },
}));
const testJobs = jobsModule.module({
  createJob: async ([name], ctx) => {
    countCall(`create ${String(name)}`);
    return TestJob({ id: String(name), run: ctx.execution.id });
  },
  richer: async ([when]) => {
    countCall("richer");
    const at = when as unknown as Date;
    // SAFETY: A codemode module can return values the journal can keep; the type only names JSON.
    return {
      isDate: at instanceof Date,
      next: new Date(at.getTime() + 1),
      big: 2n ** 70n,
      bytes: new Uint8Array([1, 2]),
      buffer: new ArrayBuffer(4),
    } as never;
  },
  failRich: async () => {
    countCall("failRich");
    throw Object.assign(new RangeError("too far"), {
      code: "EFAR",
      details: { limit: 3 },
      at: new Date(7),
    });
  },
  watch: async ([onEvent]) =>
    `watched ${await (onEvent as unknown as (event: string) => Promise<string>)("built")}`,
  logs: async () => {
    const encoder = new TextEncoder();
    // SAFETY: A run that doesn't replay can take a stream; the type only names JSON.
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("line 1\n"));
        controller.enqueue(encoder.encode("line 2\n"));
        controller.close();
      },
    }) as never;
  },
});

// The Worker Loader resolves imports differently under the legacy and
// the new module registry, so the same backend runs on both.
const NEW_REGISTRY_BACKEND = "worker-javascript-new-registry";
const NETWORK_BACKEND = "worker-javascript-network";

function javascriptBackend(
  env: Env,
  overrides: Partial<
    Pick<
      WorkerJavaScriptBackendOptions,
      "id" | "compatibilityFlags" | "loader" | "egress" | "maxStdioBytes"
    >
  > = {},
) {
  return new WorkerJavaScriptBackend({
    loader: env.LOADER,
    ...overrides,
    maxStdioBytes: overrides.maxStdioBytes ?? 64,
    maxCapabilityBytes: 1024,
    onWait: (call) => void waits.push(call),
    maxConcurrentCapabilityCalls: 2,
    modules: {
      "math-kit": "export const double = (value) => value * 2;",
      counter: "let count = 0; export const bump = () => ++count;",
      facade: `import { double } from "math-kit"; import { echo } from "codemode:test-host"; export const both = async (value) => ({ doubled: double(value), echoed: await echo(value) });`,
      "codemode:git": createGitModule(),
      "codemode:artifacts": createArtifactsModule(),
      "codemode:container": createContainerModule(),
      "codemode:test-session": testSession,
      "codemode:test-jobs": testJobs,
      "codemode:test-host": {
        async echo(args) {
          return { args: [...args] };
        },
        async sum(args) {
          return args.reduce<number>(
            (total, value) => total + (typeof value === "number" ? value : 0),
            0,
          );
        },
        async delete(args) {
          return { deleted: args[0] ?? null };
        },
        async tick(args) {
          return countCall(String(args[0] ?? "tick"));
        },
        // Never settles before the object restarts.
        async gate() {
          countCall("gate");
          if (!gateOpen) await new Promise(() => undefined);
          return "open";
        },
        // Never settles before a restart opens it by name.
        async hold(args) {
          const name = String(args[0]);
          countCall(name);
          if (!opened.has(name)) await new Promise(() => undefined);
          return "open";
        },
        // The execution the call belongs to.
        async execution(_args, ctx) {
          return { ...ctx.execution, metadata: { ...ctx.execution.metadata } };
        },
        // The gate, noting which execution each call belongs to.
        async executionGate(_args, ctx) {
          executions.push({ ...ctx.execution, metadata: { ...ctx.execution.metadata } });
          countCall("gate");
          if (!gateOpen) await new Promise(() => undefined);
          return { ...ctx.execution, metadata: { ...ctx.execution.metadata } };
        },
        // The gate, for a call that mustn't run twice.
        unsafeGate: unsafeToRepeat(async () => {
          countCall("gate");
          if (!gateOpen) await new Promise(() => undefined);
          return "open";
        }),
        async invalidResult() {
          // SAFETY: The test hands the bridge a non-JSON value on purpose to check that it rejects it.
          return new Date() as never;
        },
        async largeError() {
          throw new Error("x".repeat(5000));
        },
        async slow() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return null;
        },
        // Settles after args[0] milliseconds and counts the call as args[1].
        async wait(args) {
          await new Promise((resolve) => setTimeout(resolve, Number(args[0])));
          return countCall(String(args[1] ?? "wait"));
        },
        // Counts when it starts and again when it settles, and stops early
        // if its call is aborted.
        async slowTick(args, ctx) {
          countCall(`start:${String(args[1])}`);
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, Number(args[0]));
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(ctx.signal.reason);
            });
          });
          return countCall(String(args[1]));
        },
        // Waits for an answer, then returns it.
        async approve(args, ctx) {
          const action = String(args[0]);
          countCall(`ask:${action}`);
          sessionEvents.push({ id: ctx.execution.id, event: "approve" });
          const answer = await ctx.interrupt({ kind: "approval", action });
          countCall(`answered:${action}`);
          return answer;
        },
        // Like approve, but awaits first, as a real lookup would.
        async approveLater(args, ctx) {
          const action = String(args[0]);
          await new Promise((resolve) => setTimeout(resolve, 50));
          return ctx.interrupt({ kind: "approval", action });
        },
        async marker() {
          return {
            __workspace_codec__: { version: 1, type: "bytes", data: [1] },
            keep: true,
          };
        },
      },
    },
  });
}

export class HostDO extends DurableObject<Env> {
  readonly #workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#workspace = new Workspace({
      storage: ctx.storage,
      waitUntil: ctx.waitUntil.bind(ctx),
      git: createGitClient(),
      backends: [
        javascriptBackend(env),
        javascriptBackend(env, {
          id: NEW_REGISTRY_BACKEND,
          compatibilityFlags: ["nodejs_compat", "new_module_registry"],
          // Local workerd still marks the new registry experimental.
          loader: {
            load: (code: Parameters<Env["LOADER"]["load"]>[0]) =>
              env.LOADER.load({ ...code, allowExperimental: true }),
          },
        }),
        javascriptBackend(env, {
          id: NETWORK_BACKEND,
          egress: { mode: "http-gateway", gateway: ctx.exports.TestGateway },
          maxStdioBytes: 4096,
        }),
        fakeContainerBackend(),
      ],
    });
  }

  async writeFile(path: string, source: string) {
    await this.#workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/workspace", {
      recursive: true,
    });
    await this.#workspace.fs.writeFile(path, source);
  }

  async symlink(target: string, path: string) {
    await this.#workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", {
      recursive: true,
    });
    await this.#workspace.fs.symlink(target, path);
  }

  getWorkspace(): WorkspaceStub {
    return this.#workspace.stub();
  }

  readFile(path: string) {
    return this.#workspace.fs.readFile(path, "utf8");
  }

  async runRuntime(input: {
    source: string;
    cwd?: string;
    value?: WorkspaceRuntimeValue;
    id?: string;
    env?: Record<string, string>;
    stdin?: string;
    backend?: string;
  }) {
    const handle = await this.#workspace.runtime.exec(input.source, {
      backend: input.backend ?? "worker-javascript",
      cwd: input.cwd,
      input: input.value,
      id: input.id,
      env: input.env,
      stdin: input.stdin,
      encoding: "utf8",
    });
    return { id: handle.id, result: await handle.result() };
  }

  async startRuntime(input: { source: string; id: string }) {
    const handle = await this.#workspace.runtime.exec(input.source, {
      backend: "worker-javascript",
      id: input.id,
    });
    void handle.result().catch(() => undefined);
    return handle.id;
  }

  async getRuntime(id: string, resume?: "tail", network?: boolean) {
    try {
      const handle = await this.#workspace.runtime.getExec(id, {
        backend: network === true ? NETWORK_BACKEND : "worker-javascript",
        encoding: "utf8",
        resume,
      });
      return { ok: true as const, result: await handle.result() };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async startDurable(input: {
    source: string;
    id: string;
    onInterrupt?: "fail" | "restart" | "replay";
    network?: boolean;
    metadata?: Record<string, string>;
  }) {
    gateOpen = false;
    opened.clear();
    durableCalls.clear();
    executions.length = 0;
    await this.#workspace.fs.mkdir("/workspace", { recursive: true });
    const handle = await this.#workspace.runtime.exec(input.source, {
      backend: input.network === true ? NETWORK_BACKEND : "worker-javascript",
      id: input.id,
      onInterrupt: input.onInterrupt,
      metadata: input.metadata,
    });
    void handle.result().catch(() => undefined);
    // Let the run reach the gate.
    for (let attempt = 0; attempt < 500 && !durableCalls.has("gate"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return handle.id;
  }

  async startWaiting(input: {
    source: string;
    id: string;
    onInterrupt?: "fail" | "restart" | "replay";
    timeoutMs?: number;
    metadata?: Record<string, string>;
  }) {
    durableCalls.clear();
    waits.length = 0;
    const handle = await this.#workspace.runtime.exec(input.source, {
      backend: "worker-javascript",
      id: input.id,
      onInterrupt: input.onInterrupt ?? "replay",
      timeoutMs: input.timeoutMs,
      metadata: input.metadata,
    });
    void handle.result().catch(() => undefined);
    return handle.id;
  }

  pending() {
    return this.#workspace.runtime.pending();
  }

  waits() {
    return waits;
  }

  async respond(id: string, callId: string, value: WorkspaceRuntimeValue) {
    try {
      await this.#workspace.runtime.respond(id, callId, value);
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, code: (error as { code?: string }).code };
    }
  }

  // Restart the object, as a deploy or crash would.
  restart(open?: string) {
    gateOpen = true;
    if (open !== undefined) opened.add(open);
    this.ctx.abort("test restart");
  }

  async recover() {
    await this.#workspace.runtime.recover();
  }

  durableCalls() {
    return Object.fromEntries(durableCalls);
  }

  executions() {
    return executions;
  }

  sessionEvents(id: string) {
    return sessionEvents.filter((event) => event.id === id).map((event) => event.event);
  }

  releaseClose(id: string) {
    const release = heldCloses.get(id);
    release?.();
    return release !== undefined;
  }

  killRuntime(id: string) {
    return this.#workspace.runtime.killExec(id, { backend: "worker-javascript" });
  }

  disposeRuntime(id: string) {
    return this.#workspace.runtime.disposeExec(id, { backend: "worker-javascript" });
  }
}

class ModuleProbeBridge extends RpcTarget {
  read(path: string): string {
    return `host:${path}`;
  }
}

async function drainToString(readable: ReadableStream<Uint8Array>): Promise<string> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  reader.releaseLock();
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

class StdioProbeBridge extends RpcTarget {
  #sinkResult = "";

  // Direction C (stdout path): worker passes a ReadableStream as an
  // argument; host drains it.
  async sink(readable: ReadableStream<Uint8Array>): Promise<void> {
    this.#sinkResult = await drainToString(readable);
  }

  sinkResult(): string {
    return this.#sinkResult;
  }
}

// The network a run with egress reaches. It counts each request, so a
// test can tell whether a replay sent it again.
export class TestGateway extends WorkerEntrypoint<Env> {
  override async fetch(request: Request) {
    const count = countCall("fetch");
    return new Response(
      `${request.method} ${new URL(request.url).pathname} ${await request.text()} #${count}`,
      {
        headers: { "x-count": String(count) },
      },
    );
  }
}

export default class extends WorkerEntrypoint<Env> {
  override async fetch(request: Request) {
    const url = new URL(request.url);
    // `object` picks a fresh Workspace; the default is shared by every test.
    const name = url.searchParams.get("object") ?? "script-runner";
    const stub = this.env.HOST.get(this.env.HOST.idFromName(name));

    try {
      if (url.pathname === "/module-probe") {
        const worker = this.env.LOADER.load({
          compatibilityDate: "2026-06-17",
          compatibilityFlags: ["nodejs_compat"],
          mainModule: "runner.js",
          modules: {
            "runner.js": `
              import { WorkerEntrypoint } from "cloudflare:workers";
              import { install } from "workspace:capabilities";
              export default class extends WorkerEntrypoint {
                async evaluate(bridge) {
                  install(bridge);
                  globalThis.__probeBridge = bridge;
                  const user = await import("./user.js");
                  return user.default();
                }
              }
            `,
            "workspace:capabilities": {
              js: `
                let bridge;
                export function install(value) { bridge = value; }
                export function call(name, ...args) {
                  if (!bridge) throw new Error("Workspace capabilities are not installed");
                  return bridge[name](...args);
                }
              `,
            },
            "node:fs/promises": {
              js: `
                export const tag = "trusted";
                export function readFile(path) { return globalThis.__probeBridge.read(path); }
              `,
            },
            "helper.js": `export const suffix = "relative";`,
            "user.js": `
              import { readFile } from "node:fs/promises";
              import { suffix } from "./helper.js";
              export default async function run() {
                const dynamic = await import("node:fs/promises");
                return [await readFile("/workspace/probe.txt"), suffix, dynamic.tag].join("|");
              }
            `,
          },
          globalOutbound: null,
        });
        const entrypoint = worker.getEntrypoint() as unknown as {
          evaluate(bridge: ModuleProbeBridge): Promise<string>;
          [Symbol.dispose]?: () => void;
        };
        try {
          return new Response(await entrypoint.evaluate(new ModuleProbeBridge()));
        } finally {
          entrypoint[Symbol.dispose]?.();
          (worker as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
        }
      }
      if (url.pathname === "/stdio-probe") {
        const worker = this.env.LOADER.load({
          compatibilityDate: "2026-06-17",
          compatibilityFlags: ["nodejs_compat"],
          mainModule: "runner.js",
          modules: {
            "runner.js": `
              import { WorkerEntrypoint } from "cloudflare:workers";
              export default class extends WorkerEntrypoint {
                async evaluate(bridge, stdin) {
                  const results = {};
                  try {
                    results.stdin = await (async () => {
                      const reader = stdin.getReader();
                      const parts = [];
                      while (true) {
                        const next = await reader.read();
                        if (next.done) break;
                        parts.push(new TextDecoder().decode(next.value));
                      }
                      return parts.join("");
                    })();
                  } catch (error) {
                    results.stdin = "ERR:" + (error instanceof Error ? error.message : String(error));
                  }
                  try {
                    const transform = new IdentityTransformStream();
                    const writer = transform.writable.getWriter();
                    const done = bridge.sink(transform.readable);
                    await writer.write(new TextEncoder().encode("from-isolate"));
                    await writer.close();
                    await done;
                    results.sink = "ok";
                  } catch (error) {
                    results.sink = "ERR:" + (error instanceof Error ? error.message : String(error));
                  }
                  return results;
                }
              }
            `,
          },
          globalOutbound: null,
        });
        const entrypoint = worker.getEntrypoint() as unknown as {
          evaluate(
            bridge: StdioProbeBridge,
            stdin: ReadableStream<Uint8Array>,
          ): Promise<Record<string, string>>;
          [Symbol.dispose]?: () => void;
        };
        const bridge = new StdioProbeBridge();
        const stdinTransform = new IdentityTransformStream();
        void (async () => {
          const writer = stdinTransform.writable.getWriter();
          await writer.write(new TextEncoder().encode("from-host"));
          await writer.close();
        })();
        try {
          const results = await entrypoint.evaluate(bridge, stdinTransform.readable);
          return Response.json({ ...results, sinkResult: bridge.sinkResult() });
        } finally {
          entrypoint[Symbol.dispose]?.();
          (worker as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
        }
      }
      if (url.pathname === "/runtime") {
        return Response.json(
          await stub.runRuntime(
            (await request.json()) as {
              source: string;
              cwd?: string;
              value?: WorkspaceRuntimeValue;
              id?: string;
              env?: Record<string, string>;
              stdin?: string;
              backend?: string;
            },
          ),
        );
      }

      // Runs code through the Workspace stub, as another Worker would.
      if (url.pathname === "/runtime-stub") {
        const body = (await request.json()) as {
          source: string;
          metadata?: Record<string, string>;
        };
        // SAFETY: The object's getWorkspace returns a WorkspaceStub; RPC typing can't follow it that deep.
        using workspace = (await stub.getWorkspace()) as unknown as WorkspaceStub;
        using handle = await workspace.runtime.exec(body.source, {
          backend: "worker-javascript",
          encoding: "utf8",
          metadata: body.metadata,
        });
        return Response.json(await handle.result());
      }

      if (url.pathname === "/runtime-start") {
        return Response.json({
          id: await stub.startRuntime((await request.json()) as { source: string; id: string }),
        });
      }

      if (url.pathname === "/runtime-get") {
        const response = await stub.getRuntime(
          url.searchParams.get("id") ?? "missing",
          url.searchParams.get("resume") === "tail" ? "tail" : undefined,
          url.searchParams.has("network"),
        );
        return response.ok
          ? Response.json(response.result)
          : Response.json({ error: response.error }, { status: 400 });
      }

      if (url.pathname === "/durable-start") {
        return Response.json({
          id: await stub.startDurable(
            (await request.json()) as {
              source: string;
              id: string;
              onInterrupt?: "fail" | "restart" | "replay";
              network?: boolean;
              metadata?: Record<string, string>;
            },
          ),
        });
      }

      if (url.pathname === "/durable-restart") {
        await stub.restart(url.searchParams.get("open") ?? undefined).catch(() => undefined);
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/durable-recover") {
        await stub.recover();
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/interrupt-start") {
        return Response.json({
          id: await stub.startWaiting(
            (await request.json()) as {
              source: string;
              id: string;
              onInterrupt?: "fail" | "restart" | "replay";
              timeoutMs?: number;
              metadata?: Record<string, string>;
            },
          ),
        });
      }

      if (url.pathname === "/interrupt-waits") {
        return Response.json(await stub.waits());
      }

      if (url.pathname === "/interrupt-pending") {
        return Response.json(await stub.pending());
      }

      if (url.pathname === "/interrupt-respond") {
        const body = (await request.json()) as {
          id: string;
          callId: string;
          value: WorkspaceRuntimeValue;
        };
        return Response.json(await stub.respond(body.id, body.callId, body.value));
      }

      if (url.pathname === "/session-release") {
        return Response.json(await stub.releaseClose(url.searchParams.get("id") ?? ""));
      }

      if (url.pathname === "/session-events") {
        return Response.json(await stub.sessionEvents(url.searchParams.get("id") ?? ""));
      }

      if (url.pathname === "/durable-executions") {
        return Response.json(await stub.executions());
      }

      if (url.pathname === "/durable-calls") {
        return Response.json(await stub.durableCalls());
      }

      if (url.pathname === "/runtime-kill") {
        await stub.killRuntime(url.searchParams.get("id") ?? "missing");
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/runtime-dispose") {
        await stub.disposeRuntime(url.searchParams.get("id") ?? "missing");
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/write") {
        await stub.writeFile(
          url.searchParams.get("path") ?? "/workspace/script.js",
          await request.text(),
        );
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/symlink") {
        await stub.symlink(
          url.searchParams.get("target") ?? "/outside-secret.txt",
          url.searchParams.get("path") ?? "/workspace/outside-link",
        );
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/read") {
        return new Response(
          await stub.readFile(url.searchParams.get("path") ?? "/workspace/result.txt"),
        );
      }

      return new Response("not found", { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  }
}
