// Example Vite-built Worker + Durable Object whose Workspace ships a
// directory from the project into every workspace.
//
// `computer:bundle/src/skills` is served by computerBundle() in
// vite.config.ts. It resolves to the files under src/skills, as text,
// plus a version computed at build time. WorkerBundle() copies them to
// /workspace/.agents/skills as a read-only mount, and replaces the copy
// whenever the version changes: on a deploy, or under `vite dev` when
// you edit a file.
//
// The shell is just-bash in a Dynamic Worker, as in
// examples/worker-shell, so the bundled files can be read with ordinary
// commands through POST /c/<name>/exec.

import { DurableObject } from "cloudflare:workers";
import {
  getWorkspace,
  WorkerBundle,
  WorkspaceServiceProxy,
  withWorkspace,
} from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import skills from "computer:bundle/src/skills";

// Re-exported so the runtime can wrap it into the loopback binding the
// WorkerShellBackend hands its Dynamic Worker.
export { WorkspaceServiceProxy };

export class Agent extends withWorkspace(class extends DurableObject<Env> {}, (self) => {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: Env };
  return {
    storage: ctx.storage,
    backends: [
      new WorkerShellBackend({
        loader: env.LOADER,
        workspace: { binding: "Agent", id: ctx.id.toString() },
        ctx,
      }),
    ],
    mounts: {
      "/workspace/.agents/skills": WorkerBundle(skills),
    },
  };
}) {}

interface ExecRequest {
  command?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const execMatch = url.pathname.match(/^\/c\/([^/]+)\/exec\/?$/);
    if (execMatch) return handleExec(request, env, execMatch[1]);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        [
          "vite-bundle example",
          "",
          "  POST /c/<name>/exec    run a shell command (JSON result)",
          "",
          "src/skills is mounted read-only at /workspace/.agents/skills. Try:",
          "",
          `  curl -X POST ${url.origin}/c/demo/exec -d '{"command":"cat /workspace/.agents/skills/hello/SKILL.md"}'`,
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

  const stub = env.Agent.get(env.Agent.idFromName(name));
  // `wrangler types` doesn't surface the accessor the withWorkspace
  // mixin installs, so cast at the boundary.
  const ws = await getWorkspace(stub as unknown as Parameters<typeof getWorkspace>[0]);
  try {
    const handle = await ws.runtime.exec(body.command, { encoding: "utf8" });
    return Response.json(await handle.result());
  } catch (error) {
    return errorJSON(error, 500);
  }
}

function errorJSON(error: unknown, status: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: message }, { status });
}
