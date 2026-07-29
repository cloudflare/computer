/**
 * Worker entrypoint for the minimal Think chat example.
 *
 * There is no bespoke HTTP surface here. `routeAgentRequest` forwards
 * every `/agents/assistant/<name>` request to the Assistant Durable
 * Object, which speaks Think's WebSocket chat protocol. The terminal
 * client in `cli/chat.mjs` connects to that protocol with the AI SDK
 * v7 TUI; the browser could connect to the same DO with `useAgentChat`
 * from `@cloudflare/think/react`.
 *
 * The Assistant, WorkspaceProxy, and WorkspaceServiceProxy classes are
 * re-exported so the runtime can resolve them by name: Assistant is
 * the DO binding and container class, WorkspaceProxy carries computerd's
 * outbound /ws upgrade back to the DO, and WorkspaceServiceProxy is
 * the loopback Fetcher the worker backend hands into its Dynamic
 * Worker so the in-isolate shell can reach back into the host
 * workspace.
 */

import { routeAgentRequest } from "agents";
import { Assistant, WorkspaceProxy, WorkspaceServiceProxy } from "./agent.js";

export { Assistant, WorkspaceProxy, WorkspaceServiceProxy };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response(
        [
          "minimal think chat example",
          "",
          "  Connect a terminal client with `npm run chat`, or point any",
          "  Think/agents chat client at /agents/assistant/<name>.",
        ].join("\n"),
        { headers: { "content-type": "text/plain" } },
      )
    );
  },
} satisfies ExportedHandler<Env>;
