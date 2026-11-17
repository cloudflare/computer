// `assets` custom command for the worker-backend's shell isolate.
//
// Like the `git` command, this is only a thin bridge. The Dynamic
// Worker does not receive the R2 binding or signing secrets; it
// forwards `assets publish <path> [<expiry>]` to the host Workspace
// stub, and the host publishes through the assets client configured
// on the Workspace.

import { type CustomCommand, defineCommand } from "just-bash";

import { runAssetsCommand } from "../workspace-commands";

export interface AssetsCommandHost {
  assets?: {
    publish(path: string, options: { expiresAfter: number }): Promise<string>;
  };
}

export function defineAssetsCommand(ws: AssetsCommandHost): CustomCommand {
  return defineCommand("assets", async (args, ctx) => {
    const assets = ws.assets;
    return runAssetsCommand(
      args,
      ctx.cwd,
      assets && ((path, options) => assets.publish(path, options)),
    );
  });
}
