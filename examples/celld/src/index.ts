import { DurableObject } from "cloudflare:workers";

import { type DurableObjectStorageLike, getWorkspace, withWorkspace } from "@cloudflare/computer";

export class CelldWorkspace extends withWorkspace(class extends DurableObject<Env> {}, (self) => {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: Env };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    // No runtime backend for now: celld's current Worker Loader can create
    // Dynamic Workers, but it does not yet expose enough RPC/clone semantics
    // for Computer's WorkerJavaScriptBackend bridge. This prototype focuses on
    // the durable Workspace filesystem.
    backends: [],
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

}

interface CelldWorkspaceRpc {
  writeFile(path: string, body: ArrayBuffer): Promise<void>;
  readFile(path: string): Promise<ArrayBuffer>;
  rm(path: string, options: { recursive?: boolean }): Promise<void>;
  readdir(path: string, limit: number): Promise<unknown>;
  mkdir(path: string): Promise<void>;
}

const MOUNT_ROOT = "/workspace";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
    "No runtime backend is configured; this example is filesystem-only.",
    "",
  ].join("\n");
}
