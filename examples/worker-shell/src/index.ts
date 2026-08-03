// Example Worker + Durable Object that runs a Workspace whose
// shell is a Dynamic Worker.
//
// The DO holds a Workspace whose WorkerShellBackend dispatches every
// shell.exec into a Dynamic Worker loaded through env.LOADER.
// The Dynamic Worker reaches the host workspace through a
// DurableObjectNamespace binding wired into its env, the same
// way a Worker outside the loader would reach the DO. Each exec
// fetches a fresh stub; no shared state, and every filesystem
// RPC the shell makes runs in the host DO's own request context.
//
// Wire shape:
//
//   client ──► Worker /c/<name>/{file,exec}
//                │  (DO RPC calls)
//                ▼
//          ContainerExample DO ──► Workspace ──► WorkerShellBackend
//                                                    │
//                                                    │  env.LOADER.get(...)
//                                                    ▼
//                                              Dynamic Worker
//                                              (ShellWorker)
//                                                    │
//                                                    │ env.HOST.get(id)
//                                                    │   getWorkspace(stub)
//                                                    ▼
//                                       back to ContainerExample DO

import { DurableObject } from "cloudflare:workers";

import {
  type DurableObjectStorageLike,
  getWorkspace,
  R2Bucket,
  WorkspaceServiceProxy,
  withWorkspace,
} from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
// Opt-in shell commands. Each import pulls one command group into
// this Worker's bundle; a group you do not import is unreachable
// and the bundler drops it. Pass the ones you want to the
// WorkerShellBackend `commands` option below. Other importable groups:
// @cloudflare/computer/shell/{html-to-markdown,python,js-exec,yq,
// file,xan,jq}.
import curl from "@cloudflare/computer/shell/curl";
import jq from "@cloudflare/computer/shell/jq";

// Re-export so the runtime can wrap WorkspaceServiceProxy into a
// loopback Fetcher binding. The DO reaches the wrapped class
// through ctx.exports.WorkspaceServiceProxy(...) inside the
// WorkerShellBackend below.
export { WorkspaceServiceProxy };

// The mixin owns the Workspace and installs the prototype accessor
// `getWorkspace` dispatches to: callers in this Worker reach it with
// getWorkspace(stub), and the Dynamic Worker's env.HOST binding lands
// on the same door by id. The options callback runs after super(...),
// so it can read self.ctx / self.env.
export class ContainerExample extends withWorkspace(class extends DurableObject<Env> {}, (self) => {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: Env };
  return {
    // ctx.storage.sql.exec returns a narrower row type than
    // DurableObjectStorageLike declares; the runtime shape
    // matches. Cast through unknown to bypass invariance.
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerShellBackend({
        loader: env.LOADER,
        workspace: { binding: "ContainerExample", id: ctx.id.toString() },
        ctx,
        // Only the groups listed here ship. Core (cat, ls, grep,
        // sed, …) is always included; drop an import above to
        // shrink the bundle by that command's cost.
        commands: [curl, jq],
      }),
    ],
    // Mount the Bucket binding at /workspace/r2. Seed it with
    // `npm run seed:r2` so the first read returns "hello world".
    // The bucket is read-only; writes under /workspace/r2
    // reject with EROFS.
    mounts: {
      "/workspace/r2": R2Bucket(env.Bucket),
    },
  };
}) {}

// ---------------------------------------------------------------
// Worker HTTP surface (mirrors examples/container)
// ---------------------------------------------------------------

interface ExecRequest {
  command?: string;
  argv?: string[];
  cwd?: string;
  encoding?: "utf8";
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
          "worker example",
          "",
          `  PUT  /c/<name>/file/workspace/<path>     write file at ${MOUNT_ROOT}/<path>`,
          `  GET  /c/<name>/file/workspace/<path>     read file at ${MOUNT_ROOT}/<path>`,
          "  POST /c/<name>/exec                      run a shell command (JSON result)",
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
  // `wrangler types` doesn't surface the accessor the withWorkspace
  // mixin installs, so cast at the boundary.
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

  let command: string;
  if (typeof body.command === "string" && body.command.length > 0) {
    command = body.command;
  } else if (Array.isArray(body.argv) && body.argv.length > 0) {
    command = body.argv.map(shellQuote).join(" ");
  } else {
    return errorJSON(new Error("must provide command or argv"), 400);
  }

  const stub = env.ContainerExample.get(env.ContainerExample.idFromName(name));
  const ws = await getWorkspace(stub as unknown as Parameters<typeof getWorkspace>[0]);
  try {
    const handle = await ws.runtime.exec(command, { cwd: body.cwd, encoding: "utf8" });
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

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-+=:,./@%]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
