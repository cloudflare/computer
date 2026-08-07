import { DurableObject } from "cloudflare:workers";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { codeMcpServer } from "@cloudflare/codemode/mcp";
import {
  type DurableObjectStorageLike,
  getWorkspace,
  WorkspaceServiceProxy,
  withWorkspace,
} from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createComputerMcpServer } from "./computer-mcp.js";

interface Env {
  LOADER: WorkerLoader;
  CodemodeExample: DurableObjectNamespace<CodemodeExample>;
}

export { WorkspaceServiceProxy };

const CodemodeExampleBase = withWorkspace(class extends DurableObject<Env> {}, (self) => {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: Env };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    sessionId: ctx.id.toString(),
    backends: [
      new WorkerShellBackend({
        loader: env.LOADER,
        workspace: { binding: "CodemodeExample", id: ctx.id.toString() },
        ctx,
      }),
    ],
  };
});

/** A durable Computer workspace exposed as one Codemode MCP server. */
export class CodemodeExample extends CodemodeExampleBase {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") {
      return new Response("Connect an MCP client at /mcp.\n", { status: 404 });
    }
    if (request.method !== "POST") return methodNotAllowed();

    const workspace = await getWorkspace(this);
    const computer = createComputerMcpServer(workspace);
    let server: Awaited<ReturnType<typeof codeMcpServer>> | undefined;
    try {
      server = await codeMcpServer({
        server: computer,
        executor: new DynamicWorkerExecutor({
          loader: this.env.LOADER,
          globalOutbound: null,
        }),
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await Promise.allSettled([...(server ? [server.close()] : []), computer.close()]);
    }
  }
}

export default {
  fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname !== "/mcp") {
      return new Response("Connect an MCP client at /mcp.\n", { status: 404 });
    }
    if (request.method !== "POST") return methodNotAllowed();
    return env.CodemodeExample.get(env.CodemodeExample.idFromName("example")).fetch(request);
  },
} satisfies ExportedHandler<Env>;

function methodNotAllowed() {
  return new Response("The stateless MCP endpoint accepts POST requests only.\n", {
    status: 405,
    headers: { allow: "POST" },
  });
}
