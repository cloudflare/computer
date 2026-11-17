// Example Worker + Durable Object whose Workspace runs shell commands on
// a Kitebuild machine.
//
// The machine is a BusyBox Linux userland that runs inside the Durable
// Object that owns the Workspace. It mounts the Workspace's files at
// /workspace, so the file routes below and the shell see the same files,
// with nothing to sync. Commands are real processes, so pipes and
// background jobs work, and output streams while a command runs.
//
//   client ──► Worker /c/<name>/{file,exec}
//                │  (DO RPC calls)
//                ▼
//          KitebuildExample DO ──► Workspace ──► KitebuildBackend
//                                     │               │
//                                     └── one store ──┘

import { DurableObject } from "cloudflare:workers";

import { getWorkspace, WorkerBundle, withWorkspace } from "@cloudflare/computer";
import { KitebuildBackend } from "@cloudflare/computer/backends/kitebuild";

export class KitebuildExample extends withWorkspace(class extends DurableObject<Env> {}, (self) => {
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  return {
    storage: ctx.storage,
    // Who git commits as when a command sets no identity of its own.
    defaultGitIdentity: { name: "Kitebuild example", email: "kitebuild@example.com" },
    backends: [
      new KitebuildBackend({
        env: { LANG: "C.UTF-8", TZ: "UTC" },
        // The default egress is "none": no command, git included, can
        // reach the network.
      }),
    ],
    mounts: {
      // Read-only copy of src/skills, shipped with the Worker through the
      // rule in wrangler.jsonc. Mounting it also creates /workspace when
      // the Workspace starts, so the file routes work before any command.
      "/workspace/.agents/skills": WorkerBundle("skills"),
    },
  };
}) {}

// ---------------------------------------------------------------
// Worker HTTP surface
// ---------------------------------------------------------------

interface ExecRequest {
  command?: string;
  argv?: string[];
  cwd?: string;
  stream?: boolean;
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
          "kitebuild example",
          "",
          `  PUT  /c/<name>/file/workspace/<path>     write file at ${MOUNT_ROOT}/<path>`,
          `  GET  /c/<name>/file/workspace/<path>     read file at ${MOUNT_ROOT}/<path>`,
          "  POST /c/<name>/exec                      run a shell command (JSON result,",
          "                                           or streamed output with stream: true)",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/plain" } },
      );
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function workspaceFor(env: Env, name: string) {
  const stub = env.KitebuildExample.get(env.KitebuildExample.idFromName(name));
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
  using ws = workspaceFor(env, name);

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

  const ws = workspaceFor(env, name);
  // A streamed response reads the command's events after this returns,
  // so it disposes the client itself when the stream ends.
  let streaming = false;
  try {
    const handle = await ws.runtime.exec(command, {
      cwd: body.cwd ?? MOUNT_ROOT,
      encoding: "utf8",
    });
    if (body.stream === true) {
      streaming = true;
      return streamOutput(handle, () => ws[Symbol.dispose]());
    }
    const result = await handle.result();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return errorJSON(error, 500);
  } finally {
    if (!streaming) ws[Symbol.dispose]();
  }
}

type ExecHandle = Awaited<ReturnType<ReturnType<typeof workspaceFor>["runtime"]["exec"]>>;

// Sends stdout and stderr as the command writes them, then a last line
// with the exit code.
function streamOutput(handle: ExecHandle, done: () => void): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Iterating the handle consumes it, so the exit code comes from
        // its last event rather than from result().
        for await (const event of handle) {
          if (event.name === "stdout" || event.name === "stderr") {
            controller.enqueue(encoder.encode(String(event.value)));
          } else if (event.name === "exit") {
            controller.enqueue(encoder.encode(`\n[exit ${event.code}]\n`));
          }
        }
      } catch (error) {
        controller.enqueue(encoder.encode(`\n[error ${String(error)}]\n`));
      } finally {
        controller.close();
        done();
      }
    },
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
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
