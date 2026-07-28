// Example Worker + Durable Object that runs one Workspace with
// three backends, and an optional agent layer on top.
//
// The durable object owns the filesystem (SQLite) and registers
// three ways to run a command against it:
//
//   - "shell"    just-bash in a Dynamic Worker (WorkerBackend).
//   - "codemode" LLM-authored JavaScript in a Dynamic Worker
//                (CodemodeBackend), reaching the files through a
//                state.* namespace.
//   - "container" wsd in a Cloudflare Container
//                (CloudflareContainerBackend), a full Linux
//                userland. Boots on first use only.
//
// The workspace itself knows nothing about agents. Two HTTP
// surfaces sit on top of the same durable object:
//
//   - Deterministic, no model: PUT/GET /file and POST /exec.
//   - Optional agent: POST /agent runs a model loop that drives
//     the exec tool. The loop lives in the Worker and reaches the
//     workspace through its stub, so agency is opt-in per request
//     and the workspace stays a plain workspace.
//
// The agent asks a human before it runs anything the approval policy
// holds back. A gated command stops the turn, and the turn resumes in
// a later request once someone answers, so a paused turn has to
// outlive the request that started it. That state lives in a second
// durable object, AgentSession, rather than in the workspace: the
// filesystem object stays a filesystem object.
//
// Wire shape:
//
//   client ─► Worker ─┬─ /file, /exec   deterministic, no model
//                     ├─ /agent         model loop + exec tool
//                     └─ /approvals     the human's side of the loop
//                            │
//              ┌─────────────┴──────────────┐
//              ▼                            ▼   (stub RPC)
//       AgentSession DO             CodemodeExample DO  (fs + 3 backends)
//       paused turns,                      ├─ shell     ─► Dynamic Worker (just-bash)
//       pending approvals                  ├─ codemode  ─► Dynamic Worker (JS sandbox)
//       (no fs, no backends)               └─ container ─► Cloudflare Container (wsd)

import { DurableObject } from "cloudflare:workers";

import {
  type DurableObjectStorageLike,
  Workspace,
  type WorkspaceBackend,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type WorkspaceStub,
} from "@cloudflare/workspace";
import { CodemodeBackend } from "@cloudflare/workspace/backends/codemode";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/workspace/backends/container";
import { WorkerBackend } from "@cloudflare/workspace/backends/worker";

import { type AgentTranscript, runAgentTurn } from "./agent.js";
import { AgentSession, type AgentSessionLike } from "./session.js";
import type { ExecWorkspaceLike } from "./tools/exec.js";
import type { PausedTurn } from "./turn-store.js";

// Re-export so the runtime can build the loopback bindings the
// durable object reaches through ctx.exports:
//   - WorkspaceProxy carries the container's outbound /ws upgrade
//     back to this durable object (container backend egress).
//   - WorkspaceServiceProxy is the Fetcher the worker backend hands
//     into its Dynamic Worker so the in-isolate shell can reach
//     back to getWorkspace().
// The durable object that remembers agent turns paused for approval.
export { AgentSession, WorkspaceProxy, WorkspaceServiceProxy };

// ---------------------------------------------------------------
// Durable Object: owns one Workspace with three backends.
// ---------------------------------------------------------------
export class CodemodeExample extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly #containerBackend: CloudflareContainerBackend;
  readonly #workspace: Workspace;
  // Cached so the mount root is materialized once per instance.
  #rootReady?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Both the worker and container backends reach back into this
    // durable object through a loopback keyed by {binding, id}.
    const workspaceRef = { binding: "CodemodeExample", id: ctx.id.toString() };

    this.#containerBackend = new CloudflareContainerBackend({
      id: "container",
      container: () => this,
      workspace: workspaceRef,
    });

    // Declared order sets the default (first) backend. "shell" is
    // the cheapest general-purpose backend, so it leads.
    //
    // The cast is a workaround, not a code smell: each element is a
    // WorkspaceBackend from this same library. With three backends
    // on top of the container mixin, checking the array against
    // WorkspaceBackend[] makes tsc walk the recursive capnweb
    // BackendHandle types past its instantiation-depth limit
    // (TS2589). Widening the elements up front sidesteps that walk.
    const backends = [
      new WorkerBackend({
        id: "shell",
        loader: env.LOADER,
        workspace: workspaceRef,
        ctx,
      }),
      new CodemodeBackend({
        id: "codemode",
        loader: env.LOADER,
        // Resolved lazily on first exec, after this Workspace is
        // fully constructed.
        workspace: () => this.#workspace,
      }),
      this.#containerBackend,
    ] as unknown as WorkspaceBackend[];

    this.#workspace = new Workspace({
      // ctx.storage.sql.exec returns a narrower row type than
      // DurableObjectStorageLike declares; the runtime shape
      // matches. Cast through unknown to bypass invariance.
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends,
    });
  }

  // ---- Worker-facing RPC surface --------------------------------

  // Returns an RpcTarget the caller uses to reach the Workspace.
  // Methods on the returned stub round-trip into this durable
  // object over Workers RPC.
  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#workspace.ready();
    await this.#ensureRoot();
    return this.#workspace.stub();
  }

  // Materialize the /workspace mount root on a fresh instance.
  //
  // A new workspace starts with an empty tree, and the file surface
  // does not create parent directories, so the first
  // PUT /file/workspace/<path> would reject with ENOENT. The other
  // examples never hit this because they mount an R2 bucket under
  // /workspace, and registering a mount runs the same recursive
  // mkdir on its root. This example has no mount, so it does that
  // one mkdir itself. Recursive, so it is idempotent; cached, so it
  // runs once per instance rather than on every request.
  #ensureRoot(): Promise<void> {
    this.#rootReady ??= this.#workspace.fs.mkdir("/workspace", { recursive: true });
    return this.#rootReady;
  }

  // ---- WebSocket: the container's outbound /ws upgrade -----------

  override async fetch(request: Request): Promise<Response> {
    return this.#containerBackend.handleFetch(request);
  }
}

// ---------------------------------------------------------------
// Worker HTTP surface
// ---------------------------------------------------------------

interface ExecRequest {
  command?: string;
  cwd?: string;
  backend?: string;
}

interface AgentRequest {
  prompt?: string;
}

interface ApprovalRequest {
  approved?: boolean;
  reason?: string;
}

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

    const agentMatch = url.pathname.match(/^\/c\/([^/]+)\/agent\/?$/);
    if (agentMatch) return handleAgent(request, env, agentMatch[1]);

    const turnMatch = url.pathname.match(/^\/c\/([^/]+)\/agent\/([^/]+)\/?$/);
    if (turnMatch) return handleTurn(request, env, turnMatch[1], turnMatch[2]);

    const approvalsMatch = url.pathname.match(/^\/c\/([^/]+)\/approvals\/?$/);
    if (approvalsMatch) return handleApprovals(request, env, approvalsMatch[1]);

    const approvalMatch = url.pathname.match(/^\/c\/([^/]+)\/approvals\/([^/]+)\/?$/);
    if (approvalMatch) return handleApproval(request, env, approvalMatch[1], approvalMatch[2]);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        [
          "codemode example",
          "",
          `  PUT  /c/<name>/file/workspace/<path>     write file at ${MOUNT_ROOT}/<path>`,
          `  GET  /c/<name>/file/workspace/<path>     read file at ${MOUNT_ROOT}/<path>`,
          "  POST /c/<name>/exec                      run one command (JSON result)",
          "                                           body: { command, cwd?, backend? }",
          "                                           backend: shell | codemode | container",
          "  POST /c/<name>/agent                     run an agent turn (JSON transcript)",
          "                                           body: { prompt }",
          "  GET  /c/<name>/agent/<turnId>            one turn's record",
          "  GET  /c/<name>/approvals                 commands waiting on a human",
          "  POST /c/<name>/approvals/<approvalId>    answer one of them; resumes the",
          "                                           turn once its last one is answered",
          "                                           body: { approved, reason? }",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/plain" } },
      );
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleFile(
  request: Request,
  env: Env,
  name: string,
  path: string,
): Promise<Response> {
  const stub = env.CodemodeExample.get(env.CodemodeExample.idFromName(name));
  const ws = await stub.getWorkspace();

  if (request.method === "PUT") {
    const body = new Uint8Array(await request.arrayBuffer());
    try {
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

  const stub = env.CodemodeExample.get(env.CodemodeExample.idFromName(name));
  const ws = await stub.getWorkspace();
  try {
    const handle = await ws.shell.exec(body.command, {
      cwd: body.cwd,
      encoding: "utf8",
      backend: body.backend,
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

async function handleAgent(request: Request, env: Env, name: string): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  let body: AgentRequest;
  try {
    body = (await request.json()) as AgentRequest;
  } catch {
    return errorJSON(new Error("invalid JSON body"), 400);
  }
  if (typeof body.prompt !== "string" || body.prompt.length === 0) {
    return errorJSON(new Error("must provide prompt"), 400);
  }

  const turnId = crypto.randomUUID();
  try {
    const transcript = await runAgentTurn({
      env,
      workspace: await workspaceFor(env, name),
      prompt: body.prompt,
    });
    const turn = await recordTurn(env, name, turnId, transcript, {
      toolCalls: [],
      resolved: [],
      createdAt: Date.now(),
    });
    return transcriptJSON(turn, transcript, 200);
  } catch (error) {
    return errorJSON(error, 500);
  }
}

// GET one turn's record: what it ran, what it is waiting for, and
// which decisions a human already took.
async function handleTurn(
  request: Request,
  env: Env,
  name: string,
  turnId: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
  }
  const turn = await sessionFor(env, name).getTurn(turnId);
  if (turn == null) return errorJSON(new Error(`no turn ${turnId}`), 404);

  // The message history is the model's working state, not something a
  // client needs; everything else is the audit trail.
  const { messages: _messages, awaiting: _awaiting, ...record } = turn;
  return jsonResponse(record, 200);
}

// GET the approval queue for this workspace.
async function handleApprovals(request: Request, env: Env, name: string): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
  }
  const pending = await sessionFor(env, name).pendingApprovals();
  return jsonResponse({ pending }, 200);
}

// POST one human decision. Resolving the last outstanding approval on
// a turn resumes it in this same request, so the response is the
// transcript of the resumed pass — which may itself pause again.
async function handleApproval(
  request: Request,
  env: Env,
  name: string,
  approvalId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  let body: ApprovalRequest;
  try {
    body = (await request.json()) as ApprovalRequest;
  } catch {
    return errorJSON(new Error("invalid JSON body"), 400);
  }
  if (typeof body.approved !== "boolean") {
    return errorJSON(new Error("must provide approved as a boolean"), 400);
  }

  const session = sessionFor(env, name);
  const outcome = await session.resolveApproval(approvalId, body.approved, body.reason);
  // Either the id was never issued, or somebody already answered it.
  // Both mean this request changed nothing, and treating a repeat as a
  // fresh approval would run the command twice.
  if (outcome == null) {
    return errorJSON(new Error(`no approval ${approvalId} is waiting for an answer`), 404);
  }

  const { turn, ready, answers } = outcome;

  // One model step can ask about several commands, and the resume has
  // to carry every answer at once, so the turn waits for the rest.
  if (!ready) {
    return jsonResponse(
      {
        status: "awaiting-approval",
        turnId: turn.turnId,
        text: "",
        finishReason: "",
        steps: 0,
        stepsUsed: turn.stepsUsed,
        toolCalls: turn.toolCalls,
        pendingApprovals: turn.pending,
      },
      202,
    );
  }

  try {
    const transcript = await runAgentTurn({
      env,
      workspace: await workspaceFor(env, name),
      resume: {
        messages: turn.messages,
        approvals: answers.map((answer) => ({
          approvalId: answer.approvalId,
          approved: answer.approved,
          reason: answer.reason,
        })),
      },
      stepsUsed: turn.stepsUsed,
    });

    // The turn's own history carries forward: commands from earlier
    // passes belong to the same turn as the ones this pass ran.
    const resumed = await recordTurn(env, name, turn.turnId, transcript, turn);
    return transcriptJSON(resumed, transcript, 200);
  } catch (error) {
    return errorJSON(error, 500);
  }
}

// See AgentSessionLike for why the stub is reached through a named
// interface rather than its own inferred type.
function sessionFor(env: Env, name: string): AgentSessionLike {
  const stub = env.AgentSession.get(env.AgentSession.idFromName(name));
  return stub as unknown as AgentSessionLike;
}

// The workspace stub drives the exec tool. Its exec/result methods
// behave exactly like a local Workspace at runtime, but the capnweb
// stub wraps them in promise-pipelined types that don't structurally
// match the plain ExecWorkspaceLike the tool declares. Cast at this
// one boundary.
async function workspaceFor(env: Env, name: string): Promise<ExecWorkspaceLike> {
  const stub = env.CodemodeExample.get(env.CodemodeExample.idFromName(name));
  return (await stub.getWorkspace()) as unknown as ExecWorkspaceLike;
}

// Persist where a turn got to. A completed turn is kept too, so its
// record stays readable after the fact.
async function recordTurn(
  env: Env,
  name: string,
  turnId: string,
  transcript: AgentTranscript,
  previous: Pick<PausedTurn, "toolCalls" | "resolved" | "createdAt">,
): Promise<PausedTurn> {
  const now = Date.now();
  const turn: PausedTurn = {
    turnId,
    status: transcript.status,
    messages: transcript.messages,
    pending: transcript.pendingApprovals,
    awaiting: transcript.pendingApprovals.map((approval) => approval.approvalId),
    resolved: previous.resolved,
    toolCalls: [...previous.toolCalls, ...transcript.toolCalls],
    stepsUsed: transcript.stepsUsed,
    createdAt: previous.createdAt,
    updatedAt: now,
  };
  await sessionFor(env, name).saveTurn(turn);
  return turn;
}

// The client-facing shape of a transcript. `messages` is deliberately
// left out: it is the model's working state, and the resume path reads
// it from storage rather than from the client.
function transcriptJSON(turn: PausedTurn, transcript: AgentTranscript, status: number): Response {
  return jsonResponse(
    {
      status: turn.status,
      turnId: turn.turnId,
      text: transcript.text,
      finishReason: transcript.finishReason,
      steps: transcript.steps,
      stepsUsed: turn.stepsUsed,
      toolCalls: turn.toolCalls,
      pendingApprovals: turn.pending,
    },
    status,
  );
}

function jsonResponse(body: unknown, status: number): Response {
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
