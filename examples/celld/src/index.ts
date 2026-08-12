import { DurableObject } from "cloudflare:workers";
import { Agent, routeAgentRequest } from "agents";

import {
  type DurableObjectStorageLike,
  getWorkspace,
  type ModuleExecutionEnvelope,
  type ModuleExecutionInput,
  Workspace,
  type WorkspaceModuleBackend,
  type WorkspaceModuleBackendHandle,
  type WorkspaceModuleBackendHost,
  type WorkspaceRuntimeEvent,
  type WorkspaceRuntimeLoader,
  type WorkspaceRuntimeValue,
  withWorkspace,
} from "@cloudflare/computer";
import { createAITools } from "@cloudflare/computer/tools";

export class CelldWorkspace extends withWorkspace(class extends DurableObject<Env> {}, (self) => {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: Env };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    // celld's Worker Loader can run Dynamic Workers. This example uses a
    // small celld-specific JavaScript backend below because the full
    // WorkerJavaScriptBackend filesystem bridge still needs additional RPC
    // support in celld.
    backends: env.LOADER ? [new CelldJavaScriptBackend(env.LOADER)] : [],
  };
}) {
  async writeFile(path: string, body: ArrayBuffer): Promise<void> {
    const ws = await getWorkspace(this);
    await ws.fs.mkdir(parentDirectory(path), { recursive: true });
    await ws.fs.writeFile(path, new Uint8Array(body));
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    const ws = await getWorkspace(this);
    const stream = await ws.fs.readFile(path, {});
    return collect(stream);
  }

  async rm(path: string, options: { recursive?: boolean }): Promise<void> {
    const ws = await getWorkspace(this);
    await ws.fs.rm(path, { recursive: options.recursive, force: true });
  }

  async readdir(path: string, limit: number): Promise<unknown> {
    const ws = await getWorkspace(this);
    await ws.fs.mkdir(MOUNT_ROOT, { recursive: true });
    return ws.fs.readdir(path, { limit });
  }

  async mkdir(path: string): Promise<void> {
    const ws = await getWorkspace(this);
    await ws.fs.mkdir(path, { recursive: true });
  }

  async exec(request: RunnableExecRequest): Promise<unknown> {
    const ws = await getWorkspace(this);
    const handle = await ws.runtime.exec(request.source, {
      backend: "celld-javascript",
      cwd: request.cwd ?? MOUNT_ROOT,
      input: request.input,
      env: request.env,
      stdin: request.stdin,
      encoding: "utf8",
    });
    return handle.result();
  }
}

interface ExecRequest {
  source?: string;
  input?: WorkspaceRuntimeValue;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

type RunnableExecRequest = Required<Pick<ExecRequest, "source">> & Omit<ExecRequest, "source">;

class CelldJavaScriptBackend implements WorkspaceModuleBackend {
  readonly protocol = "module" as const;
  readonly type = "celld-javascript";
  readonly callable = true;
  readonly id = "celld-javascript";

  constructor(private readonly loader: WorkspaceRuntimeLoader) {}

  async connect(_host: WorkspaceModuleBackendHost): Promise<WorkspaceModuleBackendHandle> {
    return new CelldJavaScriptBackendHandle(this.loader, this.id);
  }
}

class CelldJavaScriptBackendHandle implements WorkspaceModuleBackendHandle {
  private readonly records = new Map<string, WorkspaceRuntimeEvent[]>();

  constructor(
    private readonly loader: WorkspaceRuntimeLoader,
    private readonly backendId: string,
  ) {}

  async exec(input: ModuleExecutionInput): Promise<ModuleExecutionEnvelope> {
    const id = input.id ?? crypto.randomUUID();
    const events = await this.run(id, input);
    this.records.set(id, events);
    return { id, events: streamEvents(events) };
  }

  async getExec(input: { id: string; after?: number | "tail" }): Promise<ModuleExecutionEnvelope> {
    const events = this.records.get(input.id);
    if (!events) throw Object.assign(new Error(`no such execution: ${input.id}`), { code: "ENOENT" });
    const after = input.after === "tail" ? Math.max(0, events.length - 1) : input.after ?? 0;
    return { id: input.id, events: streamEvents(events.filter((event) => event.seq > after)) };
  }

  async killExec(_input: { id: string }): Promise<void> {
    throw new Error(`${this.backendId} executions are synchronous and cannot be killed after admission.`);
  }

  async disposeExec(input: { id: string }): Promise<void> {
    this.records.delete(input.id);
  }

  private async run(id: string, input: ModuleExecutionInput): Promise<WorkspaceRuntimeEvent[]> {
    try {
      const worker = this.loader.load({
        compatibilityDate: "2026-05-26",
        compatibilityFlags: ["nodejs_compat", "js_rpc"],
        limits: { cpuMs: input.timeoutMs ?? 30_000 },
        mainModule: "runner.js",
        modules: {
          "entry.js": input.source,
          "runner.js": celldJavaScriptRunner(),
        },
        globalOutbound: null,
      });
      const entrypoint = worker.getEntrypoint("Runner", {
        limits: { cpuMs: input.timeoutMs ?? 30_000 },
      }) as {
        evaluate(
          input: WorkspaceRuntimeValue,
          context: { env: Record<string, string>; cwd: string; stdin: string },
        ): Promise<{ value: WorkspaceRuntimeValue; stdout: string; stderr: string }>;
      };
      const result = await entrypoint.evaluate(input.input ?? null, {
        env: input.env ?? {},
        cwd: input.cwd ?? MOUNT_ROOT,
        stdin: typeof input.stdin === "string" ? input.stdin : decodeBytes(input.stdin),
      });
      const events: WorkspaceRuntimeEvent[] = [];
      if (result.stdout) events.push({ id, seq: events.length + 1, name: "stdout", value: encode(result.stdout) });
      if (result.stderr) events.push({ id, seq: events.length + 1, name: "stderr", value: encode(result.stderr) });
      events.push({ id, seq: events.length + 1, name: "exit", code: 0, result: result.value ?? null });
      return events;
    } catch (error) {
      return [
        {
          id,
          seq: 1,
          name: "stderr",
          value: encode(`${error instanceof Error ? error.message : String(error)}\n`),
        },
        { id, seq: 2, name: "exit", code: 1 },
      ];
    }
  }
}

interface AgentState {
  requests: number;
}

export class FilesystemAgent extends Agent<Env, AgentState> {
  initialState: AgentState = { requests: 0 };

  async onRequest(request: Request): Promise<Response> {
    const workspace = new Workspace({
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      backends: [],
    });
    const tools = createAITools({ workspace, assets: false });
    const url = new URL(request.url);
    const nextState = { requests: (this.state.requests ?? 0) + 1 };
    this.setState(nextState);

    if (url.pathname.endsWith("/tools")) {
      return json({
        agent: "FilesystemAgent",
        state: nextState,
        tools: Object.keys(tools),
        note: "Computer tools construct successfully inside an Agents SDK Agent on celld; runtime exec/publish are intentionally absent.",
      });
    }

    if (request.method === "PUT" && url.pathname.endsWith("/file")) {
      const path = resolveWorkspacePath(url.searchParams.get("path") ?? "");
      if (path === null) return pathError(url.searchParams.get("path") ?? "");
      await workspace.fs.mkdir(parentDirectory(path), { recursive: true });
      await workspace.fs.writeFile(path, new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && url.pathname.endsWith("/file")) {
      const path = resolveWorkspacePath(url.searchParams.get("path") ?? "");
      if (path === null) return pathError(url.searchParams.get("path") ?? "");
      try {
        const stream = await workspace.fs.readFile(path, {});
        return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
      } catch (error) {
        return errorJSON(error, errorCode(error) === "ENOENT" ? 404 : 500);
      }
    }

    return json({
      agent: "FilesystemAgent",
      state: nextState,
      routes: ["GET ./tools", "PUT ./file?path=workspace/<path>", "GET ./file?path=workspace/<path>"],
    });
  }
}

interface CelldWorkspaceRpc {
  writeFile(path: string, body: ArrayBuffer): Promise<void>;
  readFile(path: string): Promise<ArrayBuffer>;
  rm(path: string, options: { recursive?: boolean }): Promise<void>;
  readdir(path: string, limit: number): Promise<unknown>;
  mkdir(path: string): Promise<void>;
  exec(request: RunnableExecRequest): Promise<unknown>;
}

const MOUNT_ROOT = "/workspace";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    const url = new URL(request.url);

    const fileMatch = url.pathname.match(/^\/fs\/(.+)$/);
    if (fileMatch) {
      const path = resolveWorkspacePath(fileMatch[1]);
      if (path === null) return pathError(fileMatch[1]);
      return handleFile(request, env, cellName(url), path);
    }

    const listMatch = url.pathname.match(/^\/ls\/(.+)$/);
    if (listMatch) {
      const path = resolveWorkspacePath(listMatch[1]);
      if (path === null) return pathError(listMatch[1]);
      return handleList(request, env, cellName(url), path);
    }

    const mkdirMatch = url.pathname.match(/^\/mkdir\/(.+)$/);
    if (mkdirMatch) {
      const path = resolveWorkspacePath(mkdirMatch[1]);
      if (path === null) return pathError(mkdirMatch[1]);
      return handleMkdir(request, env, cellName(url), path);
    }

    if (url.pathname === "/exec") {
      return handleExec(request, env, cellName(url));
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(helpText(env), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function workspaceStub(env: Env, name: string): CelldWorkspaceRpc {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(name)) as unknown as CelldWorkspaceRpc;
}

async function handleFile(
  request: Request,
  env: Env,
  name: string,
  path: string,
): Promise<Response> {
  const stub = workspaceStub(env, name);

  if (request.method === "GET") {
    try {
      return new Response(await stub.readFile(path), {
        headers: { "content-type": "application/octet-stream" },
      });
    } catch (error) {
      return errorJSON(error, errorCode(error) === "ENOENT" ? 404 : 500);
    }
  }

  if (request.method === "PUT") {
    try {
      await stub.writeFile(path, await request.arrayBuffer());
      return new Response(null, { status: 204 });
    } catch (error) {
      return errorJSON(error, 500);
    }
  }

  if (request.method === "DELETE") {
    try {
      await stub.rm(path, { recursive: urlBoolean(request.url, "recursive") });
      return new Response(null, { status: 204 });
    } catch (error) {
      return errorJSON(error, 500);
    }
  }

  return new Response("method not allowed", {
    status: 405,
    headers: { allow: "GET, PUT, DELETE" },
  });
}

async function handleList(
  request: Request,
  env: Env,
  name: string,
  path: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
  }
  try {
    const entries = await workspaceStub(env, name).readdir(path, numberParam(request.url, "limit") ?? 1024);
    return json({ cell: name, path, entries });
  } catch (error) {
    return errorJSON(error, errorCode(error) === "ENOENT" ? 404 : 500);
  }
}

async function handleMkdir(
  request: Request,
  env: Env,
  name: string,
  path: string,
): Promise<Response> {
  if (request.method !== "POST" && request.method !== "PUT") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST, PUT" } });
  }
  try {
    await workspaceStub(env, name).mkdir(path);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorJSON(error, 500);
  }
}

async function handleExec(request: Request, env: Env, name: string): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  if (!env.LOADER) {
    return errorJSON(new Error("Dynamic Worker loader disabled; start celld with CELLD_WORKER_LOADER=LOADER"), 501);
  }
  let body: ExecRequest;
  try {
    body = (await request.json()) as ExecRequest;
  } catch {
    return errorJSON(new Error("invalid JSON body"), 400);
  }
  if (typeof body.source !== "string" || body.source.length === 0) {
    return errorJSON(new Error("must provide source"), 400);
  }
  try {
    return json(await workspaceStub(env, name).exec(body as RunnableExecRequest));
  } catch (error) {
    return errorJSON(error, 500);
  }
}

function resolveWorkspacePath(rest: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  const candidate = `/${decoded.replace(/^\/+/, "")}`;
  if (candidate !== MOUNT_ROOT && !candidate.startsWith(`${MOUNT_ROOT}/`)) return null;
  if (candidate.split("/").includes("..")) return null;
  return candidate;
}

function cellName(url: URL): string {
  return url.searchParams.get("cell") || "default";
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? MOUNT_ROOT : path.slice(0, index);
}

function urlBoolean(rawUrl: string, name: string): boolean {
  const value = new URL(rawUrl).searchParams.get(name);
  return value === "1" || value === "true";
}

function numberParam(rawUrl: string, name: string): number | undefined {
  const value = new URL(rawUrl).searchParams.get(name);
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function pathError(rest: string): Response {
  return errorJSON(new Error(`path must sit under ${MOUNT_ROOT}; got /${rest}`), 400);
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function errorJSON(error: unknown, status: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message, code: errorCode(error) }, status);
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeBytes(value: Uint8Array | string | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function streamEvents(events: WorkspaceRuntimeEvent[]): ReadableStream<WorkspaceRuntimeEvent> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
}

function celldJavaScriptRunner(): string {
  return `
    import { WorkerEntrypoint } from "cloudflare:workers";
    import * as userModule from "entry.js";

    export class Runner extends WorkerEntrypoint {
      async evaluate(input, context) {
        const stdout = [];
        const stderr = [];
        const write = (target, args) => target.push(args.map(String).join(" ") + "\\n");
        console.log = (...args) => write(stdout, args);
        console.info = (...args) => write(stdout, args);
        console.warn = (...args) => write(stderr, args);
        console.error = (...args) => write(stderr, args);
        globalThis.process = {
          env: context.env || {},
          argv: ["workspace", "entry.js"],
          cwd: () => context.cwd || "/workspace",
          platform: "linux",
          stdin: context.stdin || "",
          stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
          stderr: { write: (chunk) => { stderr.push(String(chunk)); return true; } },
        };
        const result = typeof userModule.default === "function" ? await userModule.default(input) : userModule.default;
        return { value: result ?? null, stdout: stdout.join(""), stderr: stderr.join("") };
      }
    }

    export default {
      fetch() {
        return new Response("ok");
      }
    };
  `;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function helpText(env: Env): string {
  return [
    "computer + celld prototype",
    "",
    "Persistent filesystem (cell defaults to `default`; pass ?cell=name to shard):",
    `  PUT    /fs/workspace/<path>         raw body -> ${MOUNT_ROOT}/<path>`,
    `  GET    /fs/workspace/<path>         read ${MOUNT_ROOT}/<path>`,
    `  DELETE /fs/workspace/<path>         delete file (add ?recursive=1 for dirs)`,
    `  GET    /ls/workspace/<dir>          list ${MOUNT_ROOT}/<dir>`,
    `  POST   /mkdir/workspace/<dir>       mkdir -p ${MOUNT_ROOT}/<dir>`,
    "",
    env.LOADER
      ? "Dynamic Worker backend: POST /exec { source, input?, cwd?, env?, stdin? }"
      : "Dynamic Worker backend disabled (set CELLD_WORKER_LOADER=LOADER before starting celld).",
    "",
    "Agents SDK smoke route:",
    "  GET    /agents/filesystem-agent/<name>",
    "  GET    /agents/filesystem-agent/<name>/tools",
    "  PUT    /agents/filesystem-agent/<name>/file?path=workspace/<path>",
    "  GET    /agents/filesystem-agent/<name>/file?path=workspace/<path>",
    "",
  ].join("\n");
}
