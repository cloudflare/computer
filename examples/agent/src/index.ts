// Example Worker + Durable Object holding one Workspace with three
// backends behind it.
//
// The example exists to show an agent deciding what a command is
// allowed to do before it runs it, so it needs more than one place
// where a command can run: the three backends enforce a withheld write
// capability differently, and the difference is the point rather than
// an inconvenience.
//
//   worker-shell       just-bash in a Dynamic Worker. Reaches the
//                      workspace over RPC, so a withheld capability
//                      turns every write into EROFS inside the
//                      command, before anything lands.
//
//   worker-javascript  an ECMAScript module in a Dynamic Worker.
//                      Same story: the module's writes go through the
//                      same filesystem handle and fail the same way.
//
//   container-shell    computerd over real coreutils, writing to its
//                      own copy of the tree and syncing back. Nothing
//                      stops the write there; the refusal happens when
//                      the changes are pulled, and shows up as
//                      skipped entries rather than as a failed
//                      command.
//
// Wire shape:
//
//   client ──► Worker /c/<name>/{file,exec}
//                │  (DO RPC)
//                ▼
//          AgentExample DO ──► Workspace ──┬─► WorkerShellBackend ──► Dynamic Worker
//                                          ├─► WorkerJavaScriptBackend ──► Dynamic Worker
//                                          └─► CloudflareContainerBackend ──► computerd

import { DurableObject } from "cloudflare:workers";

import {
  type DurableObjectStorageLike,
  getWorkspace,
  type WorkspaceOptions,
  WorkspaceProxy,
  type WorkspaceRuntimeLoader,
  WorkspaceServiceProxy,
  withWorkspace,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import {
  createAgentTools,
  createApprovalGate,
  createAudit,
  DEFAULT_BACKEND,
  execApproval,
  SYSTEM_PROMPT,
} from "./agent.js";

// Re-exported so the runtime can wrap each class into a loopback
// binding: the container backend reaches the DO through
// ctx.exports.WorkspaceProxy, the Dynamic Worker shell through
// ctx.exports.WorkspaceServiceProxy. The classes live in
// @cloudflare/computer; the re-export is what puts them in this
// Worker's top-level module graph.
export { WorkspaceProxy, WorkspaceServiceProxy };

// The container half of the DO. The backend is a field here rather
// than on AgentExample because withWorkspace's options callback needs
// it while constructing the Workspace: base-class fields are
// initialized by the time that callback runs, subclass fields are not.
class AgentBase extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly container_backend: CloudflareContainerBackend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: "AgentExample", id: this.ctx.id.toString() },
  });

  // Held as a field so the /audit route can read the trail back out.
  // A real host would ship these somewhere durable; the ring buffer is
  // here to be read while the example runs.
  readonly audit = createAudit({
    sink: (record) => {
      console.log(JSON.stringify({ audit: record }));
    },
  });
}

// Named, with an explicit return type: an inline callback would make
// the class's own base expression part of its inferred type.
// DurableObject keeps ctx and env protected, so read them through a
// cast the way the mixin's own docs do.
function workspaceOptions(self: InstanceType<typeof AgentBase>): WorkspaceOptions {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: Env };

  // One binding, two backends, and a cast to get it there. The
  // generated WorkerLoader type does satisfy what both backends ask
  // for, but checking it against them here overruns tsc's
  // instantiation depth limit: Env holds a namespace of AgentExample,
  // which is declared below in terms of the mixin, so resolving the
  // argument reenters the class it is being resolved for. The single
  // backend in examples/worker-shell stays under the limit and needs
  // no cast; three backends in one function does not.
  //
  // The cast names both target shapes rather than going through `any`,
  // so each constructor call below is still checked against the
  // options it actually takes.
  const loader = env.LOADER as unknown as NonNullable<
    ConstructorParameters<typeof WorkerShellBackend>[0]["loader"]
  > &
    WorkspaceRuntimeLoader;

  const backends: WorkspaceOptions["backends"] = [
    new WorkerShellBackend({
      loader,
      workspace: { binding: "AgentExample", id: ctx.id.toString() },
      ctx,
    }),
    new WorkerJavaScriptBackend({ loader }),
    self.container_backend,
  ];
  return {
    // ctx.storage.sql.exec returns a narrower row type than
    // DurableObjectStorageLike declares; the runtime shape matches.
    // Cast through unknown to bypass invariance.
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    waitUntil: ctx.waitUntil.bind(ctx),
    // The first backend is the default, so a command that names no
    // backend runs under just-bash: the one of the three that
    // refuses a withheld write outright.
    backends,
    // Both seams are installed on the Workspace rather than around the
    // agent, which is the point of them being here: they cover the
    // HTTP routes below and anything added later, not only the model's
    // path through the tools.
    gate: createApprovalGate(),
    audit: self.audit,
  };
}

export class AgentExample extends withWorkspace(AgentBase, workspaceOptions) {
  // computerd dials back with a /ws upgrade; everything else on this
  // door is the agent, whose response is a stream and so cannot come
  // back over an RPC method.
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return this.container_backend.handleFetch(request);
    if (url.pathname === "/agent") return this.#agent(request);
    if (url.pathname === "/audit") return json(this.audit.records());
    return new Response("not found", { status: 404 });
  }

  async #agent(request: Request): Promise<Response> {
    let body: { messages?: UIMessage[] };
    try {
      body = (await request.json()) as { messages?: UIMessage[] };
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const messages = body.messages ?? [];

    // getWorkspace(this) takes the local path: no RPC, and it awaits
    // ready() on the way through.
    const workspace = await getWorkspace(this);
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai(MODEL_ID),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(messages),
      tools: createAgentTools({ workspace }),
      // Approval is decided here rather than on the tool, which is
      // where the AI SDK moved it: the tool-level `needsApproval`
      // option is deprecated in v7.
      toolApproval: { exec: execApproval() },
      // The conversation lives on the client, so an approval reaches
      // this Worker as a claim the client makes about a decision the
      // user supposedly took. Signing the request when it is issued
      // and checking the signature when it comes back is what stops a
      // client from writing itself an approval for a command nobody
      // saw. Without this the gate and the capability are still in
      // place, but the human in the loop is only advisory.
      experimental_toolApprovalSecret: await this.#approvalSecret(),
      stopWhen: stepCountIs(16),
    });

    return result.toUIMessageStreamResponse();
  }

  /**
   * The HMAC key for signing approval requests.
   *
   * Generated on first use and kept in this DO's own storage rather
   * than configured as a secret. It never has to leave the object that
   * both issues and verifies the signature, so there is nothing for an
   * operator to set up and nothing to leak through a binding.
   */
  async #approvalSecret(): Promise<Uint8Array> {
    const existing = await this.ctx.storage.get<Uint8Array>(APPROVAL_SECRET_KEY);
    if (existing !== undefined) return existing;
    const secret = crypto.getRandomValues(new Uint8Array(32));
    await this.ctx.storage.put(APPROVAL_SECRET_KEY, secret);
    return secret;
  }
}

const MODEL_ID = "@cf/zai-org/glm-5.2";
const APPROVAL_SECRET_KEY = "approval-secret";

// ---------------------------------------------------------------
// Worker HTTP surface
// ---------------------------------------------------------------

interface ExecRequest {
  command?: string;
  backend?: string;
  cwd?: string;
}

// computerd mounts the VFS at /workspace inside the container, and the
// two Dynamic Worker backends see the same tree at the same path. The
// file handler holds every path it touches under that root: the
// example means to expose the mounted tree and nothing else.
const MOUNT_ROOT = "/workspace";

function resolveMountPath(rest: string): string | null {
  const candidate = `/${rest}`;
  if (candidate !== MOUNT_ROOT && !candidate.startsWith(`${MOUNT_ROOT}/`)) {
    return null;
  }
  if (candidate.split("/").includes("..")) return null;
  return candidate;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const fileMatch = url.pathname.match(/^\/c\/([^/]+)\/file\/(.+)$/);
    if (fileMatch) {
      const resolved = resolveMountPath(fileMatch[2]);
      if (resolved === null) {
        return errorJSON(new Error(`path must sit under ${MOUNT_ROOT}; got /${fileMatch[2]}`), 400);
      }
      return handleFile(request, env, fileMatch[1], resolved);
    }

    const execMatch = url.pathname.match(/^\/c\/([^/]+)\/exec\/?$/);
    if (execMatch) return handleExec(request, env, execMatch[1]);

    // The agent's reply is a stream and the audit trail lives on the
    // object, so both are handled by the DO itself rather than through
    // an RPC method. Rewritten onto the path the DO's fetch switches
    // on; the workspace name stays in the id, not the URL.
    const agentMatch = url.pathname.match(/^\/c\/([^/]+)\/(agent|audit)\/?$/);
    if (agentMatch) {
      const stub = env.AgentExample.get(env.AgentExample.idFromName(agentMatch[1]));
      return stub.fetch(new Request(`http://do/${agentMatch[2]}`, request));
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        [
          "agent example",
          "",
          `  PUT  /c/<name>/file/workspace/<path>     write file at ${MOUNT_ROOT}/<path>`,
          `  GET  /c/<name>/file/workspace/<path>     read file at ${MOUNT_ROOT}/<path>`,
          "  POST /c/<name>/exec                      run a shell command (JSON result)",
          "  POST /c/<name>/agent                     one agent turn (UI message stream)",
          "  GET  /c/<name>/audit                     what the audit hook recorded",
          "",
          `Default exec backend: ${DEFAULT_BACKEND}. Talk to the agent with`,
          "`npm run chat --workspace @example/computer-agent`.",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/plain" } },
      );
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function workspaceFor(env: Env, name: string) {
  const stub = env.AgentExample.get(env.AgentExample.idFromName(name));
  // `wrangler types` doesn't surface the accessor the withWorkspace
  // mixin installs, so cast at the boundary.
  return getWorkspace(stub as unknown as Parameters<typeof getWorkspace>[0]);
}

async function handleFile(
  request: Request,
  env: Env,
  name: string,
  path: string,
): Promise<Response> {
  const ws = await workspaceFor(env, name);

  if (request.method === "PUT") {
    const body = new Uint8Array(await request.arrayBuffer());
    try {
      // Nothing has created /workspace yet on a fresh object. The other
      // examples get it as a side effect of mounting a bucket
      // underneath it; this one mounts nothing, so the first write to a
      // new object would otherwise fail on a missing parent. Both calls
      // pass the gate and land in the audit trail.
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent.length > 0) await ws.fs.mkdir(parent, { recursive: true });
      await ws.fs.writeFile(path, body);
      return new Response(null, { status: 204 });
    } catch (error) {
      return errorJSON(error, 500);
    }
  }

  if (request.method === "GET") {
    try {
      const stream = await ws.fs.readFile(path, {});
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") return errorJSON(error, 404);
      return errorJSON(error, 500);
    }
  }

  return new Response("method not allowed", { status: 405, headers: { allow: "GET, PUT" } });
}

async function handleExec(request: Request, env: Env, name: string): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  }

  let body: ExecRequest;
  try {
    body = (await request.json()) as ExecRequest;
  } catch {
    return errorJSON(new Error("invalid JSON body"), 400);
  }
  if (typeof body.command !== "string" || body.command.length === 0) {
    return errorJSON(new Error("must provide command"), 400);
  }

  const ws = await workspaceFor(env, name);
  try {
    const handle = await ws.runtime.exec(body.command, {
      backend: body.backend,
      cwd: body.cwd,
      encoding: "utf8",
    });
    const result = await handle.result();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return errorJSON(error, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorJSON(error: unknown, status: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
