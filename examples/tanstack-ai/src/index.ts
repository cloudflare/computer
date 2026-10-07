// A one-shot agent on TanStack AI, working in a durable Workspace.
//
//   client ──► Worker / ──► TanStackAgent DO ──► Workspace (files + shell)
//                                       │
//                                       └──► Workers AI, through env.AI

import { DurableObject } from "cloudflare:workers";

import {
  type DurableObjectStorageLike,
  Workspace,
  WorkspaceServiceProxy,
  type WorkspaceStub,
} from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createTanStackTools } from "@cloudflare/computer/tools/tanstack-ai";
import { chat, maxIterations, streamToText } from "@tanstack/ai";
import { cloudflareText } from "@tanstack/ai-cloudflare";

// The worker-shell backend reaches back into this durable object by
// binding name and id, so the shell shares the agent's filesystem.
export { WorkspaceServiceProxy };

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export class TanStackAgent extends DurableObject<Env> {
  workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerShellBackend({
        id: "shell",
        loader: this.env.LOADER,
        workspace: { binding: "TanStackAgent", id: this.ctx.id.toString() },
        ctx: this.ctx,
      }),
    ],
  });

  /** Lets the shell in the Dynamic Worker reach this workspace. */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.workspace.ready();
    return this.workspace.stub();
  }

  async run(task: string): Promise<string> {
    const tools = createTanStackTools({
      workspace: this.workspace,
      shell: {
        backends: { shell: { description: "A just-bash shell over the workspace files." } },
        defaultBackend: "shell",
      },
    });

    const stream = chat({
      // The cast is a version mismatch, not a real one: the adapter is
      // on @cloudflare/workers-types v4 and this repo is on v5, so the
      // two structurally identical `Ai` types will not unify. Drop it
      // once the adapter moves to v5.
      adapter: cloudflareText(MODEL, { binding: this.env.AI as unknown as never }),
      systemPrompts: [
        "You are working in a directory at /workspace. Use the tools to do what the user asks, then say what you did.",
      ],
      messages: [{ role: "user", content: task }],
      tools,
      // Bound the spend if the model fails to converge.
      agentLoopStrategy: maxIterations(10),
    });

    return await streamToText(stream);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response('POST a task, e.g. {"task":"write hello.txt"}\n', { status: 405 });
    }

    const { task } = (await request.json()) as { task?: string };
    if (!task) return new Response("body needs a task\n", { status: 400 });

    const agent = env.TanStackAgent.get(env.TanStackAgent.idFromName("demo"));
    return new Response(`${await agent.run(task)}\n`);
  },
} satisfies ExportedHandler<Env>;
