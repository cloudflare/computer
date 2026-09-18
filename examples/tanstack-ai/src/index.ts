// A one-shot agent built on TanStack AI, working in a durable Workspace.
//
// POST a task, and the agent uses the workspace tools to carry it out.
// TanStack AI owns the loop: `chat()` calls the tools the model asks
// for, feeds the results back, and keeps going until the model is done.
// `streamToText` waits for that to finish and returns the final text.
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
import { createTanStackTools } from "@cloudflare/computer/tools/tanstack";
import { chat, maxIterations, streamToText } from "@tanstack/ai";
import { cloudflareText } from "@tanstack/ai-cloudflare";

// The worker-shell backend reaches back into this durable object by
// binding name and id, so the in-isolate shell shares one filesystem
// with the agent.
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
        defaultBackend: "shell",
        backends: { shell: { description: "A shell with common text commands." } },
      },
    });

    const stream = chat({
      // The Cloudflare adapter talks to Workers AI through the binding,
      // so this example needs no API key.
      //
      // The cast is a version mismatch, not a real one: the adapter
      // depends on version 4 of @cloudflare/workers-types while this
      // repository is on version 5, so TypeScript sees two structurally
      // identical `Ai` types from different packages and declines to
      // unify them. Drop the cast once the adapter moves to version 5.
      adapter: cloudflareText(MODEL, { binding: this.env.AI as unknown as never }),
      systemPrompts: [
        "You are working in a directory at /workspace. Use the tools to do what the user asks, then say what you did.",
      ],
      messages: [{ role: "user", content: task }],
      // The tools arrive keyed by name, which is the shape a server
      // registry wants; chat() takes them as a list.
      tools: Object.values(tools),
      // Stop after ten model turns, so a confused model cannot loop
      // forever on someone else's bill.
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
