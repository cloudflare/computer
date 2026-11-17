// One Workspace whose Kitebuild backend gives an agent everything it
// needs to work on JavaScript projects: a shell, Node.js scripts run
// with node, and project files shipped with the Vite-built Worker. A pi
// agent works on top, with the same files and the same shell.
//
// The shell is a Kitebuild machine, a BusyBox Linux userland in this
// Durable Object, with Kitebuild's toolchain: npm, node, tsc, vite and
// vitest run inside the Worker, with no container.
//
//   page (ui/) or client ──► Worker /c/<name>/{file,exec,run,agent}
//                │
//                ▼
//          Agent DO ──► Workspace ──► KitebuildBackend (+ toolchain)
//                │                          │
//                │                          └──► EgressGateway ──► GitHub, npm
//                └──► Workers AI, through env.AI

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import { getWorkspace, WorkerBundle, withWorkspace } from "@cloudflare/computer";
import { KitebuildBackend } from "@cloudflare/computer/backends/kitebuild";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { jq, rg } from "@cloudflare/kitebuild-cli-tools";
// Each group from its own subpath, so the Worker uploads only the wasm
// these commands need. essentials is curl and git; node is node, npm,
// npx, pnpm, bun and bunx; typescript is tsc; vite is vite and Tailwind; vitest is
// vitest; wrangler is wrangler.
import { essentialsTools } from "@cloudflare/kitebuild-toolchain/programs/groups/essentials";
import { nodeTools } from "@cloudflare/kitebuild-toolchain/programs/groups/node";
import { typescriptTools } from "@cloudflare/kitebuild-toolchain/programs/groups/typescript";
import { viteTools } from "@cloudflare/kitebuild-toolchain/programs/groups/vite";
import { vitestTools } from "@cloudflare/kitebuild-toolchain/programs/groups/vitest";
import { wranglerTools } from "@cloudflare/kitebuild-toolchain/programs/groups/wrangler";
import { toolchain } from "@cloudflare/kitebuild-toolchain/toolset";
// From the models subpath, not the package root: workers-ai.ts loads
// pi's OpenAI API lazily, so the bundler initializes models.js lazily
// too, and the root's side-effect-free re-export would skip that step.
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
// Served by computerBundle() in vite.config.ts: the files under
// src/skills, as text, plus a version computed at build time.
import skills from "computer:bundle/src/skills";

import { WORKERS_AI_PROVIDER, workersAI } from "./workers-ai";

// The toolchain runs package code in Worker Loader isolates owned by
// these entrypoints, which toolchain() finds on ctx.exports. Imported
// from the host-runtime subpath, not the package root, so the Worker
// does not upload every tool's wasm.
export {
  BuildIsolateRunner,
  D1Host,
  GuestIsolateRunner,
  KvHost,
  PackageCacheOrigin,
  R2Host,
  RemoteBindingOrigin,
} from "@cloudflare/kitebuild-toolchain/host-runtime";

// Hosts the shell may reach: GitHub for git, and the npm registry for
// installs. Everything else is refused.
const ALLOWED_HOSTS = new Set([
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "registry.npmjs.org",
]);

// Every request the shell makes passes through here, as the backend's
// `http-gateway` egress.
export class EgressGateway extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const host = new URL(request.url).hostname;
    console.log(`egress ${ALLOWED_HOSTS.has(host) ? "allow" : "deny"} ${request.method} ${host}`);
    if (ALLOWED_HOSTS.has(host)) return fetch(request);
    return new Response(`blocked by the example's egress policy: ${host}\n`, { status: 403 });
  }
}

// pi sends tool results as content arrays, which this model accepts.
// Llama 3.3, Qwen 3 and gpt-oss on Workers AI take only string content
// and fail on the second turn.
const MODEL = "@cf/moonshotai/kimi-k2.6";

// Bound the spend if the model fails to converge.
const MAX_TURNS = 40;

const SYSTEM_PROMPT = [
  "You are a software engineer working in /workspace, a durable directory.",
  "Run commands with exec. The shell is BusyBox with git, npm, pnpm, bun, node, tsc, vite, vitest, rg and jq.",
  "Read /skills/exec/SKILL.md before your first command.",
  "Do what the user asks, check your work by running the project's typecheck and tests, then say what you did.",
].join(" ");

export class Agent extends withWorkspace(class extends DurableObject<Env> {}, (self) => {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: Env };
  return {
    storage: ctx.storage,
    // Who git commits as when a command sets no identity of its own.
    defaultGitIdentity: { name: "Kitebuild agent", email: "agent@example.com" },
    backends: [
      new KitebuildBackend({
        // The Workspace directories the shell sees: the agent's files, and
        // the skills mounted below.
        paths: ["/workspace", "/skills"],
        egress: { mode: "http-gateway", gateway: ctx.exports.EgressGateway({}) },
        env: { CI: "1", LANG: "C.UTF-8", TZ: "UTC" },
        commands: [
          rg(),
          jq(),
          toolchain({
            loader: env.LOADER,
            exports: ctx.exports,
            groups: [
              essentialsTools,
              nodeTools,
              typescriptTools,
              viteTools,
              vitestTools,
              wranglerTools,
            ],
            // KV, R2 and D1 for the bindings a project's Vitest config
            // declares, served by RemoteBindingOrigin and the hosts above.
            extras: { KB_REMOTE: env.KB_REMOTE },
          }),
        ],
        // git's requests go through the gateway too. When the Worker has a
        // GITHUB_TOKEN secret, this adds it to requests for github.com, so
        // the agent can push without the token ever being in the shell.
        git: {
          fetch: (request, send) => {
            const token = (env as { GITHUB_TOKEN?: string }).GITHUB_TOKEN;
            if (token && new URL(request.url).hostname === "github.com") {
              request.headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
            }
            return send(request);
          },
        },
      }),
    ],
    mounts: {
      // A read-only copy of src/skills, replaced when a deploy changes it.
      // Outside /workspace, because dofs refuses mkdir of a directory that
      // holds a read-only mount, and pi's write tool runs mkdir on a file's
      // parent before writing it.
      "/skills": WorkerBundle(skills),
    },
  };
}) {
  // Runs one task to the end and returns the agent's last reply and the
  // tools it called.
  async run(task: string): Promise<{ reply: string; commands: string[] }> {
    const commands: string[] = [];
    let reply = "";
    await this.#loop(task, (event) => {
      if (event.type === "call") commands.push(`${event.name} ${JSON.stringify(event.arguments)}`);
      if (event.type === "done") reply = event.reply;
    });
    return { reply, commands };
  }

  // The same run, as newline-delimited JSON events sent as they happen,
  // for the page in ui/ to show the agent at work.
  stream(task: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start: (controller) => {
        const send = (event: AgentEvent) =>
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        this.#loop(task, send).then(
          () => controller.close(),
          (error: unknown) => {
            send({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
            controller.close();
          },
        );
      },
    });
  }

  // The agent loop: ask the model, run the tools it asks for, repeat
  // until it stops asking. `emit` hears each step.
  async #loop(task: string, emit: (event: AgentEvent) => void): Promise<void> {
    const workspace = await getWorkspace(this);
    const { tools, execute } = createPiTools({ workspace });

    const models = createModels();
    models.setProvider(workersAI(this.env.AI, MODEL));
    const model = models.getModel(WORKERS_AI_PROVIDER, MODEL);
    if (!model) throw new Error(`model ${MODEL} is not registered`);

    const messages: Message[] = [{ role: "user", content: task, timestamp: Date.now() }];

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const reply = await models.complete(model, { systemPrompt: SYSTEM_PROMPT, messages, tools });
      // pi reports a failed model call on the reply rather than throwing.
      if (reply.stopReason === "error" || reply.stopReason === "aborted") {
        throw new Error(`model call failed: ${reply.errorMessage ?? reply.stopReason}`);
      }
      messages.push(reply);

      const text = reply.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const calls = reply.content.filter((block) => block.type === "toolCall");
      if (calls.length === 0) {
        emit({ type: "done", reply: text });
        return;
      }
      if (text.trim() !== "") emit({ type: "text", text });

      for (const call of calls) {
        emit({ type: "call", id: call.id, name: call.name, arguments: call.arguments });
        const { content, isError } = await execute(call);
        const output = content
          .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
          .join("\n");
        emit({ type: "result", id: call.id, output: output.slice(-20_000), isError });
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content,
          isError,
          timestamp: Date.now(),
        });
      }
    }

    emit({ type: "done", reply: `Gave up after ${MAX_TURNS} turns.` });
  }
}

// One step of a run, as the stream sends it.
type AgentEvent =
  | { type: "text"; text: string }
  | { type: "call"; id: string; name: string; arguments: unknown }
  | { type: "result"; id: string; output: string; isError: boolean }
  | { type: "done"; reply: string }
  | { type: "error"; message: string };

// ---------------------------------------------------------------
// Worker HTTP surface
// ---------------------------------------------------------------

const MOUNT_ROOT = "/workspace";

type Client = ReturnType<typeof getWorkspace>;

function workspaceFor(env: Env, name: string): Client {
  // `wrangler types` doesn't surface the accessor the withWorkspace
  // mixin installs, so cast at the boundary.
  const stub = env.Agent.get(env.Agent.idFromName(name));
  return getWorkspace(stub as unknown as Parameters<typeof getWorkspace>[0]);
}

function agentFor(env: Env, name: string) {
  return env.Agent.get(env.Agent.idFromName(name));
}

const USAGE = [
  "kitebuild agent example",
  "",
  `  PUT  /c/<name>/file/workspace/<path>          write a file under ${MOUNT_ROOT}`,
  `  GET  /c/<name>/file/workspace/<path>          read a file under ${MOUNT_ROOT}`,
  '  POST /c/<name>/exec   { "command": "..." }    run a shell command',
  '  POST /c/<name>/kill   { "id": "..." }         stop a command started with that id',
  '  POST /c/<name>/run    { "source": "..." }     run a Node.js script with node',
  '  POST /c/<name>/agent  { "task": "..." }       run the agent on a task',
  '                                                (add "stream": true for its steps as NDJSON)',
  "",
].join("\n");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const file = url.pathname.match(/^\/c\/([^/]+)\/file(\/.+)$/);
    if (file) {
      const [, name, path] = file;
      if (!path.startsWith(`${MOUNT_ROOT}/`) || path.split("/").includes("..")) {
        return Response.json({ error: `path must sit under ${MOUNT_ROOT}` }, { status: 400 });
      }
      return handleFile(request, env, name, path);
    }

    const route = url.pathname.match(/^\/c\/([^/]+)\/(exec|kill|run|agent)\/?$/);
    if (route === null || request.method !== "POST") {
      return new Response(USAGE, {
        status: route === null && url.pathname !== "/" ? 404 : route === null ? 200 : 405,
        headers: { "content-type": "text/plain" },
      });
    }
    const [, name, kind] = route;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    if (kind === "agent") {
      if (typeof body.task !== "string") return badRequest("body needs a task");
      if (body.stream === true) {
        return new Response(await agentFor(env, name).stream(body.task), {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      return Response.json(await agentFor(env, name).run(body.task));
    }
    if (kind === "kill") {
      if (typeof body.id !== "string") return badRequest("body needs an id");
      using workspace = workspaceFor(env, name);
      using handle = await workspace.runtime.getExec(body.id);
      await handle.kill();
      return new Response(null, { status: 204 });
    }
    if (kind === "exec") {
      if (typeof body.command !== "string") return badRequest("body needs a command");
      if (body.stream === true) return streamExec(env, name, body.command, body);
      return Response.json(await exec(env, name, body.command, body));
    }
    if (typeof body.source !== "string") return badRequest("body needs a source");
    return Response.json(await runScript(env, name, body.source, body));
  },
} satisfies ExportedHandler<Env>;

interface ExecOptions {
  id?: unknown;
  cwd?: unknown;
  env?: unknown;
  stdin?: unknown;
}

async function exec(env: Env, name: string, command: string, options: ExecOptions) {
  using workspace = workspaceFor(env, name);
  using handle = await workspace.runtime.exec(command, {
    cwd: typeof options.cwd === "string" ? options.cwd : MOUNT_ROOT,
    ...(isStrings(options.env) ? { env: options.env } : {}),
    ...(typeof options.stdin === "string" ? { stdin: options.stdin } : {}),
    encoding: "utf8",
  });
  return handle.result();
}

// The same command, with its output sent as newline-delimited JSON as
// it is written, then its exit code, for the page's terminal. Given an
// `id`, POST /c/<name>/kill stops it, as the page does on Ctrl-C.
async function streamExec(env: Env, name: string, command: string, options: ExecOptions) {
  const workspace = workspaceFor(env, name);
  const handle = await workspace.runtime.exec(command, {
    ...(typeof options.id === "string" ? { id: options.id } : {}),
    cwd: typeof options.cwd === "string" ? options.cwd : MOUNT_ROOT,
    ...(isStrings(options.env) ? { env: options.env } : {}),
    encoding: "utf8",
  });
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: object) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        for await (const event of handle) {
          if (event.name === "stdout" || event.name === "stderr") {
            send({ type: event.name, data: String(event.value) });
          } else if (event.name === "exit") {
            send({ type: "exit", code: event.code });
          }
        }
      } finally {
        handle[Symbol.dispose]();
        workspace[Symbol.dispose]();
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

// Runs a Node.js script with Kitebuild's node, inside the machine, so it
// reads and writes the same files as the shell. The script is written to
// a file under `cwd`, because node runs only an entry inside the project
// it starts in, which also lets the script import that project's
// packages.
async function runScript(
  env: Env,
  name: string,
  source: string,
  options: ExecOptions & { args?: unknown },
) {
  const cwd = typeof options.cwd === "string" ? options.cwd : MOUNT_ROOT;
  const file = `${cwd}/run-${crypto.randomUUID()}.js`;
  const args = Array.isArray(options.args) ? options.args.map(String) : [];
  using workspace = workspaceFor(env, name);
  // A new Workspace has no /workspace until something creates it.
  await workspace.fs.stat(cwd).catch(() => workspace.fs.mkdir(cwd, { recursive: true }));
  await workspace.fs.writeFile(file, source);
  try {
    return await exec(env, name, ["node", file, ...args].map(shellQuote).join(" "), {
      ...options,
      cwd,
    });
  } finally {
    await workspace.fs.rm(file, { force: true });
  }
}

async function handleFile(request: Request, env: Env, name: string, path: string) {
  using workspace = workspaceFor(env, name);
  try {
    if (request.method === "PUT") {
      // Nothing creates /workspace before the first command, so a first
      // upload creates it.
      await workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await workspace.fs.writeFile(path, new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET") {
      return new Response(await workspace.fs.readFile(path, {}), {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, PUT" } });
  } catch (error) {
    const code = (error as { code?: string }).code;
    return Response.json(
      { error: error instanceof Error ? error.message : String(error), code },
      { status: code === "ENOENT" ? 404 : 500 },
    );
  }
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function isStrings(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_\-+=:,./@%]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}
