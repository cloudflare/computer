import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  type DurableObjectStorageLike,
  getWorkspace,
  type WorkspaceRuntimeLoader,
  withWorkspace,
} from "@cloudflare/computer";
import { createAITools } from "@cloudflare/computer/tools";
import { routeAgentRequest } from "agents";
import { convertToModelMessages, isStepCount, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import { CELLD_JAVASCRIPT_BACKEND_ID, CelldJavaScriptBackend } from "./celld-javascript-backend";

const MODEL_ID = "@cf/zai-org/glm-5.2";

// Keep the agent's bindings separate from the Worker Env, whose namespace
// points back to CelldAgent and would make the mixin base type recursive.
interface CelldAgentEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  LOADER?: WorkspaceRuntimeLoader;
}

class CelldAgentBase extends AIChatAgent<CelldAgentEnv> {
  protected readonly bindings: CelldAgentEnv;

  constructor(ctx: DurableObjectState, env: CelldAgentEnv) {
    super(ctx, env);
    this.bindings = env;
  }
}

export class CelldAgent extends withWorkspace(CelldAgentBase, (self) => {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: CelldAgentEnv };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: env.LOADER ? [new CelldJavaScriptBackend(env.LOADER)] : [],
  };
}) {
  override async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions,
  ): Promise<Response> {
    const workspace = await getWorkspace(this);
    const tools = createAITools({
      workspace,
      assets: false,
      ...(this.bindings.LOADER
        ? {
            shell: {
              defaultBackend: CELLD_JAVASCRIPT_BACKEND_ID,
              backends: {
                [CELLD_JAVASCRIPT_BACKEND_ID]: {
                  description: [
                    "Runs a complete JavaScript module in a celld Dynamic Worker with structured input and output.",
                    "Pass module source, not a filename or bare script. The module must have a default export. Export a function to receive `(input, ctx)` and return structured output.",
                    "",
                    "```js",
                    "export default async function main(input, ctx) {",
                    '  console.log("cwd:", ctx.cwd);',
                    "  return { received: input };",
                    "}",
                    "```",
                    "",
                    "The loaded worker cannot access the Workspace filesystem. Use read, write, edit, ls, find, grep, and delete outside exec.",
                  ].join("\n"),
                },
              },
            },
          }
        : {}),
    });
    const accountId = this.bindings.CLOUDFLARE_ACCOUNT_ID?.trim();
    const apiKey = this.bindings.CLOUDFLARE_API_TOKEN?.trim();
    if (!accountId || !apiKey) {
      throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN before starting celld.");
    }
    const model = createWorkersAI({ accountId, apiKey })(MODEL_ID);
    const result = streamText({
      abortSignal: options?.abortSignal,
      model,
      system: [
        "You are a helpful assistant with a durable workspace rooted at /workspace.",
        "Use read, ls, find, grep, write, edit, and delete to work with files.",
        this.bindings.LOADER
          ? "Use exec for JavaScript modules that do not need filesystem access."
          : "The JavaScript execution backend is disabled, so do not call exec.",
      ].join("\n"),
      messages: await convertToModelMessages(this.messages),
      tools,
      stopWhen: isStepCount(10),
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response(
        [
          "computer + celld chat agent",
          "",
          "Connect with `npm run chat`, or point an Agents chat client at",
          "/agents/celld-agent/<name>.",
        ].join("\n"),
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      )
    );
  },
} satisfies ExportedHandler<Env>;
