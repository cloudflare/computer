// `assets` custom command for the worker-backend's shell isolate.
//
// Like the `git` command, this is only a thin bridge. The Dynamic
// Worker does not receive the R2 binding or signing secrets; it
// forwards `assets publish <path> [<expiry>]` to the host Workspace
// stub, and the host publishes through the assets client configured
// on the Workspace.

import { type CustomCommand, defineCommand } from "just-bash";

const DEFAULT_EXPIRY_MS = 60 * 60 * 1000;
const USAGE = "usage: assets publish <path> [<expiry>]\n";

export interface AssetsCommandHost {
  assets?: {
    publish(path: string, options: { expiresAfter: number }): Promise<string>;
  };
}

export function defineAssetsCommand(ws: AssetsCommandHost): CustomCommand {
  return defineCommand("assets", async (args, ctx) => {
    if (args[0] !== "publish" || args.length < 2 || args.length > 3) {
      return { stdout: "", stderr: USAGE, exitCode: 2 };
    }
    if (ws.assets === undefined) {
      return {
        stdout: "",
        stderr: "assets: publishing is not configured for this workspace\n",
        exitCode: 1,
      };
    }

    const path = resolvePath(ctx.cwd, args[1]);
    const expiresAfter = args[2] === undefined ? DEFAULT_EXPIRY_MS : parseExpiry(args[2]);
    if (expiresAfter === undefined) {
      return {
        stdout: "",
        stderr: `assets: invalid expiry ${JSON.stringify(args[2])}\n`,
        exitCode: 2,
      };
    }

    try {
      const url = await ws.assets.publish(path, { expiresAfter });
      return { stdout: `${url}\n`, stderr: "", exitCode: 0 };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { stdout: "", stderr: `assets: ${message}\n`, exitCode: 1 };
    }
  });
}

function parseExpiry(input: string): number | undefined {
  const match = input.match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const result = value * multiplier;
  return result > 0 && Number.isSafeInteger(result) ? result : undefined;
}

function resolvePath(cwd: string, path: string): string {
  if (path.startsWith("/")) return normalizeAbsolute(path);
  return normalizeAbsolute(`${cwd}/${path}`);
}

function normalizeAbsolute(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}
