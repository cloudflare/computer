import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import {
  type DurableObjectStorageLike,
  getWorkspace,
  type WorkspaceClient,
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
import {
  WorkerShellBackend,
  type WorkerShellLoader,
} from "@cloudflare/computer/backends/worker-shell";
import curl from "@cloudflare/computer/shell/curl";

import {
  errorResult,
  type FetchResult,
  parseShellFetchResult,
  targetUrl,
  workspaceEgressPolicy,
} from "./egress.js";

export { WorkspaceProxy, WorkspaceServiceProxy };

export class EgressGateway extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Response | Promise<Response> {
    if (new URL(request.url).origin !== "https://example.com") {
      return new Response("custom egress permits only https://example.com", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return fetch(request, { redirect: "manual" });
  }
}

class EgressContainerBase extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly egress = workspaceEgressPolicy(this.env.EGRESS_MODE, () =>
    this.ctx.exports.EgressGateway({}),
  );

  readonly containerBackend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: "EgressExample", id: this.ctx.id.toString() },
    egress: this.egress,
  });
}

function workspaceOptions(self: InstanceType<typeof EgressContainerBase>): WorkspaceOptions {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: Env };
  const workspace = { binding: "EgressExample", id: ctx.id.toString() };

  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      self.containerBackend,
      new WorkerShellBackend({
        loader: env.LOADER as unknown as WorkerShellLoader,
        workspace,
        ctx,
        commands: [curl],
        egress: self.egress,
      }),
      new WorkerJavaScriptBackend({
        loader: env.LOADER as unknown as WorkspaceRuntimeLoader,
        egress: self.egress,
      }),
    ],
  };
}

export class EgressExample extends withWorkspace(EgressContainerBase, workspaceOptions) {
  override fetch(request: Request): Promise<Response> {
    return this.containerBackend.handleFetch(request);
  }
}

const CURL_FETCH = "curl -sS -L -o /dev/null -w '%{http_code}\\n%{content_type}' \"$URL\"";

const JAVASCRIPT_FETCH = `
export default async (url) => {
  try {
    const response = await fetch(url);
    return {
      status: response.status,
      mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || null,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === "/") {
      return new Response("POST /fetch?url=https://example.com\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (requestUrl.pathname !== "/fetch") {
      return new Response("not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }

    let url: string;
    try {
      url = targetUrl(requestUrl.searchParams.get("url"));
    } catch (error) {
      return Response.json(errorResult(error), { status: 400 });
    }

    const stub = env.EgressExample.get(env.EgressExample.idFromName("default"));
    const workspace = await getWorkspace(stub as unknown as Parameters<typeof getWorkspace>[0]);
    await workspace.fs.mkdir("/workspace", { recursive: true });
    const [container, workerShell, workerJavaScript] = await Promise.all([
      shellFetch(workspace, "container-shell", url),
      shellFetch(workspace, "worker-shell", url),
      javaScriptFetch(workspace, url),
    ]);

    return Response.json({
      mode: env.EGRESS_MODE,
      url,
      container,
      "worker-shell": workerShell,
      "worker-javascript": workerJavaScript,
    });
  },
} satisfies ExportedHandler<Env>;

async function shellFetch(
  workspace: WorkspaceClient,
  backend: "container-shell" | "worker-shell",
  url: string,
): Promise<FetchResult> {
  try {
    const handle = await workspace.runtime.exec(CURL_FETCH, {
      backend,
      env: { URL: url },
      encoding: "utf8",
    });
    const result = await handle.result();
    return parseShellFetchResult(result.exitCode, result.stdout, result.stderr);
  } catch (error) {
    return errorResult(error);
  }
}

async function javaScriptFetch(workspace: WorkspaceClient, url: string): Promise<FetchResult> {
  try {
    const handle = await workspace.runtime.exec(JAVASCRIPT_FETCH, {
      backend: "worker-javascript",
      input: url,
      encoding: "utf8",
    });
    const result = await handle.result();
    if (result.status !== "completed" || result.value === undefined) {
      return { error: result.stderr.trim() || "Worker JavaScript fetch failed" };
    }
    return result.value as FetchResult;
  } catch (error) {
    return errorResult(error);
  }
}
