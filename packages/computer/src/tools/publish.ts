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

export const publishInputSchema = z.object({
  path: z.string().min(1).describe("Absolute workspace path, e.g. /workspace/out/chart.png."),
  expiresAfterMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Link lifetime in milliseconds. Defaults to one hour."),
});

export const publishDescription =
  "Publish a file from the workspace through the configured assets publisher and return a time-limited link. Use this to hand the user an artifact you produced, such as a chart, screenshot, build output, or report.";

export interface PublishInput {
  path: string;
  expiresAfterMs?: number;
}

export type PublishResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Bind a publish executor to one workspace.
 *
 * The assets client is resolved once, at construction, so a workspace
 * without a configured publisher fails loudly when the tool is built
 * rather than on the model's first call.
 */
export function createPublishExecutor(
  workspace: PublishWorkspaceLike,
): (input: PublishInput) => Promise<PublishResult> {
  const assets = workspace.assets;
  if (!assets) {
    throw new Error("createPublishTool: workspace.assets is not configured");
  }

  return async ({ path, expiresAfterMs }) => {
    try {
      const prefix = workspace.sessionId ? `agent-${workspace.sessionId}` : undefined;
      const url = await assets.share(path, {
        expiresAfter: expiresAfterMs ?? DEFAULT_EXPIRY_MS,
        ...(prefix ? { prefix } : {}),
      });
      return { ok: true, url };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

export function createPublishTool(
  options: PublishToolOptions,
): Tool<z.infer<typeof publishInputSchema>> {
  const execute = createPublishExecutor(options.workspace);
  return tool({
    description: publishDescription,
    inputSchema: publishInputSchema,
    execute: (input) => execute(input),
  });
}
