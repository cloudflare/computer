// Example Worker + Durable Object whose container can run scripts on
// the host.
//
// The Durable Object owns one Workspace backed by one container, the
// same shape as examples/container. The one addition is the `codemode`
// option on the container backend: with it, a command inside the
// container can run `codemode < script.js`, and the script runs here,
// in a dynamic worker, with the notes connector in scope.
//
//   client ─► Worker POST /c/<name>/exec ─► DO ─► container
//                                                    │ codemode
//                                          ws://computer.internal/codemode
//                                                    ▼
//                                       DO: codemode runtime ─► dynamic worker

import { DurableObject } from "cloudflare:workers";

import { CodemodeRuntime } from "@cloudflare/codemode";
import {
  type DurableObjectStorageLike,
  getWorkspace,
  type WorkspaceOptions,
  WorkspaceProxy,
  withWorkspace,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";

import { NotesConnector } from "./notes-connector.js";

interface Env {
  LOADER: WorkerLoader;
  CodemodeExample: DurableObjectNamespace<CodemodeExample>;
}

// WorkspaceProxy is how the container reaches this Durable Object; the
// codemode runtime keeps its executions in a facet it looks up on
// ctx.exports under the name CodemodeRuntime. Both must be exported
// from the Worker entry.
export { CodemodeRuntime, WorkspaceProxy };

class ContainerBase extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly backend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: "CodemodeExample", id: this.ctx.id.toString() },
    egress: { mode: "direct" },
    codemode: {
      ctx: this.ctx,
      loader: this.env.LOADER,
      connectors: () => [new NotesConnector(this.ctx, this.env)],
    },
  });
}

function workspaceOptions(self: InstanceType<typeof ContainerBase>): WorkspaceOptions {
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [self.backend],
  };
}

export class CodemodeExample extends withWorkspace(ContainerBase, workspaceOptions) {
  // Both computerd's /api upgrade and a codemode session's /codemode
  // upgrade arrive here through WorkspaceProxy.
  override async fetch(request: Request): Promise<Response> {
    return this.backend.handleFetch(request);
  }
}

interface ExecRequest {
  command?: string;
  cwd?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const execMatch = url.pathname.match(/^\/c\/([^/]+)\/exec\/?$/);
    if (execMatch) return handleExec(request, env, execMatch[1]);

    if (url.pathname === "/") {
      return new Response(
        [
          "codemode example",
          "",
          "  POST /c/<name>/exec   run a command in the container (JSON result)",
          "",
          'Try: {"command":"codemode types"}',
          "",
        ].join("\n"),
        { headers: { "content-type": "text/plain" } },
      );
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

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
  const ws = await getWorkspace(stub as unknown as Parameters<typeof getWorkspace>[0]);
  try {
    const handle = await ws.runtime.exec(body.command, { cwd: body.cwd, encoding: "utf8" });
    const result = await handle.result();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return errorJSON(error, 500);
  }
}

function errorJSON(error: unknown, status: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
