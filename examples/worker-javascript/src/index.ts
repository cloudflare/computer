import { DurableObject } from "cloudflare:workers";

import {
  type DurableObjectStorageLike,
  getWorkspace,
  R2Bucket,
  type WorkspaceRuntimeValue,
  withWorkspace,
} from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";

export class ContainerExample extends withWorkspace(class extends DurableObject<Env> {}, (self) => {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: Env };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    waitUntil: ctx.waitUntil.bind(ctx),
    backends: [new WorkerJavaScriptBackend({ loader: env.LOADER })],
    mounts: {
      "/workspace/r2": R2Bucket(env.Bucket),
    },
  };
}) {}

interface ExecRequest {
  source?: string;
  input?: WorkspaceRuntimeValue;
  cwd?: string;
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

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        [
          "worker-javascript example",
          "",
          `  PUT  /c/<name>/file/workspace/<path>     write file at ${MOUNT_ROOT}/<path>`,
          `  GET  /c/<name>/file/workspace/<path>     read file at ${MOUNT_ROOT}/<path>`,
          "  POST /c/<name>/exec                      run an ECMAScript module (JSON result)",
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
  const stub = env.ContainerExample.get(env.ContainerExample.idFromName(name));
  const ws = await getWorkspace(stub as unknown as Parameters<typeof getWorkspace>[0]);

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

  if (typeof body.source !== "string" || body.source.length === 0) {
    return errorJSON(new Error("must provide source"), 400);
  }

  const stub = env.ContainerExample.get(env.ContainerExample.idFromName(name));
  const ws = await getWorkspace(stub as unknown as Parameters<typeof getWorkspace>[0]);
  try {
    const handle = await ws.runtime.exec(body.source, {
      backend: "worker-javascript",
      cwd: body.cwd,
      input: body.input,
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

function errorJSON(error: unknown, status: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
