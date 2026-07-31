import { DurableObject } from "cloudflare:workers";
import {
  type DurableObjectStorageLike,
  getWorkspace,
  type WorkspaceOptions,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  withWorkspace,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createGitClient } from "@cloudflare/computer/git";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createComputerMCPServer } from "./server.js";

interface Env {
  LOADER: WorkerLoader;
  MCP_TOKEN?: string;
  COMPUTER_MCP: DurableObjectNamespace<ComputerMCP>;
}

export { WorkspaceProxy, WorkspaceServiceProxy };

const TOKEN_ENCODER = new TextEncoder();

class ComputerMCPDurableObject extends DurableObject<Env> {}

class ComputerMCPBase extends withWorkspaceContainer(ComputerMCPDurableObject) {
  readonly workerShell = new WorkerShellBackend({
    loader: this.env.LOADER,
    workspace: { binding: "COMPUTER_MCP", id: this.ctx.id.toString() },
    ctx: this.ctx,
    egress: { mode: "none" },
  });

  readonly containerShell = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: "COMPUTER_MCP", id: this.ctx.id.toString() },
    egress: { mode: "direct" },
  });
}

function workspaceOptions(self: InstanceType<typeof ComputerMCPBase>): WorkspaceOptions {
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    sessionId: ctx.id.toString(),
    git: createGitClient(),
    backends: [self.workerShell, self.containerShell],
  };
}

/** One durable Computer workspace exposed through a Code Mode MCP server. */
export class ComputerMCP extends withWorkspace(ComputerMCPBase, workspaceOptions) {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    // computerd reaches this callback through an internal binding. The public
    // Worker forwards only /mcp.
    if (path === "/ws") return this.containerShell.handleFetch(request);
    if (path !== "/mcp") return new Response("not found", { status: 404 });

    const unauthorized = authorize(request, this.env.MCP_TOKEN);
    if (unauthorized) return unauthorized;
    if (request.method !== "POST") return methodNotAllowed();

    const server = await createComputerMCPServer(await getWorkspace(this), this.env.LOADER);
    const transport = new WebStandardStreamableHTTPServerTransport();
    await server.connect(transport);
    return transport.handleRequest(request);
  }
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok\n");
    if (url.pathname === "/") return home(url.origin);
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });

    const unauthorized = authorize(request, env.MCP_TOKEN);
    if (unauthorized) return unauthorized;

    const id = env.COMPUTER_MCP.idFromName("computer");
    return env.COMPUTER_MCP.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;

function authorize(request: Request, token: string | undefined): Response | undefined {
  if (!token) return new Response("MCP_TOKEN is not configured.\n", { status: 503 });

  const supplied = TOKEN_ENCODER.encode(request.headers.get("authorization") ?? "");
  const expected = TOKEN_ENCODER.encode(`Bearer ${token}`);
  if (
    supplied.byteLength === expected.byteLength &&
    crypto.subtle.timingSafeEqual(supplied, expected)
  ) {
    return undefined;
  }

  return new Response("Unauthorized\n", {
    status: 401,
    headers: { "www-authenticate": "Bearer" },
  });
}

function methodNotAllowed() {
  return new Response("The stateless MCP endpoint accepts POST requests only.\n", {
    status: 405,
    headers: { allow: "POST" },
  });
}

function home(origin: string) {
  return new Response(
    [
      "Computer MCP",
      "",
      `Endpoint: ${origin}/mcp`,
      "Authorization: Bearer <MCP_TOKEN>",
      "Default backend: worker-shell",
      "Full Linux backend: container-shell",
      "",
    ].join("\n"),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}
