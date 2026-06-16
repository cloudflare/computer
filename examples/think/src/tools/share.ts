/**
 * `share` — upload a workspace file to R2 and return a link the
 * caller can open. Built on `@cloudflare/workspace/assets`: the
 * bucket binding and credentials are bound at construction time, so
 * the model only supplies the path and an optional lifetime.
 *
 * The presigner needs R2 S3 credentials the bucket binding can't
 * surface, so the tool is only registered when those are present in
 * the environment (see `createTools` in `agent.ts`). Failures are
 * returned, not thrown, so a bad path doesn't unwind the agentic
 * loop.
 */

import type { Workspace } from "@cloudflare/workspace";
import { createAssets } from "@cloudflare/workspace/assets";
import { tool } from "ai";
import { z } from "zod";

export interface ShareToolOptions {
  workspace: Workspace;
  // R2 binding the upload goes through.
  bucket: R2Bucket;
  // S3 bucket name and credential source for the presigner.
  s3Bucket: string;
  env: Record<string, string | undefined>;
}

const DEFAULT_EXPIRY_MS = 60 * 60 * 1000; // one hour

export function createShareTool(opts: ShareToolOptions) {
  const assets = createAssets({
    ws: opts.workspace,
    bucket: opts.bucket,
    s3: { bucket: opts.s3Bucket },
    env: opts.env,
  });

  return tool({
    description:
      "Share a file from the workspace by uploading it to R2 and " +
      "returning a time-limited link. Use this to hand the user an " +
      "artifact you produced — a chart, screenshot, build output, or " +
      "report. The link expires; pass expiresAfterMs to control how " +
      "long it lives (default one hour).",
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
        const url = await assets.share(path, {
          expiresAfter: expiresAfterMs ?? DEFAULT_EXPIRY_MS,
          prefix: `agent-${opts.workspace.sessionId}`,
        });
        return { ok: true, url };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}
