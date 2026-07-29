import { type Tool, tool } from "ai";
import { z } from "zod";
import type { AssetsClient } from "../assets/index.js";

export interface PublishWorkspaceLike {
  readonly sessionId: string;
  readonly assets?: AssetsClient;
}

export interface PublishToolOptions {
  workspace: PublishWorkspaceLike;
}

const DEFAULT_EXPIRY_MS = 60 * 60 * 1000;

export function createPublishTool(
  options: PublishToolOptions,
): Tool<{ path: string; expiresAfterMs?: number }> {
  const assets = options.workspace.assets;
  if (!assets) {
    throw new Error("createPublishTool: workspace.assets is not configured");
  }

  return tool({
    description:
      "Publish a file from the workspace through the configured assets publisher and return a time-limited link. Use this to hand the user an artifact you produced, such as a chart, screenshot, build output, or report.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Absolute workspace path, e.g. /workspace/out/chart.png."),
      expiresAfterMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Link lifetime in milliseconds. Defaults to one hour."),
    }),
    execute: async ({ path, expiresAfterMs }) => {
      try {
        const prefix = options.workspace.sessionId
          ? `agent-${options.workspace.sessionId}`
          : undefined;
        const url = await assets.share(path, {
          expiresAfter: expiresAfterMs ?? DEFAULT_EXPIRY_MS,
          ...(prefix ? { prefix } : {}),
        });
        return { ok: true, url };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
