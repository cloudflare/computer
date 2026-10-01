// A one-shot agent on pi, working in a durable Workspace. pi leaves
// the agent loop to the caller, so `run` below is that whole loop.
//
//   client ──► Worker / ──► PiAgent DO ──► Workspace (files + shell)
//                                  │
//                                  └──► Workers AI, through env.AI

import { DurableObject } from "cloudflare:workers";

import {
  type DurableObjectStorageLike,
  Workspace,
  WorkspaceServiceProxy,
  type WorkspaceStub,
} from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { createModels, type Message } from "@earendil-works/pi-ai";

import { WORKERS_AI_PROVIDER, workersAI } from "./workers-ai.js";

// The worker-shell backend reaches back into this durable object by
// binding name and id, so the shell shares the agent's filesystem.
export { WorkspaceServiceProxy };

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// The one worker shell `exec` runs on.
const SHELL = {
  backends: { shell: { description: "A just-bash shell over the workspace files." } },
  defaultBackend: "shell",
};

// Bound the spend if the model fails to converge.
const MAX_TURNS = 10;

export class PiAgent extends DurableObject<Env> {
  workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerShellBackend({
        id: "shell",
        loader: this.env.LOADER,
        workspace: { binding: "PiAgent", id: this.ctx.id.toString() },
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
    const { tools, execute } = createPiTools({ workspace: this.workspace, shell: SHELL });

    const models = createModels();
    models.setProvider(workersAI(this.env.AI, MODEL));
    const model = models.getModel(WORKERS_AI_PROVIDER, MODEL);
    if (!model) throw new Error(`model ${MODEL} is not registered`);

    const messages: Message[] = [{ role: "user", content: task, timestamp: Date.now() }];

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const reply = await models.complete(model, {
        systemPrompt:
          "You are working in a directory at /workspace. Use the tools to do what the user asks, then say what you did.",
        messages,
        tools,
      });
      messages.push(reply);

      const calls = reply.content.filter((block) => block.type === "toolCall");
      if (calls.length === 0) {
        return reply.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
      }

      for (const call of calls) {
        const { content, isError } = await execute(call);
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content,
          isError,
          timestamp: Date.now(),
        });
      }
    }

    return `Gave up after ${MAX_TURNS} turns.`;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response('POST a task, e.g. {"task":"write hello.txt"}\n', { status: 405 });
    }

    const { task } = (await request.json()) as { task?: string };
    if (!task) return new Response("body needs a task\n", { status: 400 });

    const agent = env.PiAgent.get(env.PiAgent.idFromName("demo"));
    return new Response(`${await agent.run(task)}\n`);
  },
} satisfies ExportedHandler<Env>;
