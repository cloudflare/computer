// `ws:git`: the Workspace's Git client for isolate JavaScript.
//
//   import { status, diff, log, clone, cli } from "ws:git";
//
// Every path the isolate passes is confined to the JavaScript backend's
// root. Commands that change the repository need a read-write backend,
// and commands that reach the network are denied unless the module is
// created with `allowNetwork: true`: they run from the host, so the
// isolate's own egress settings do not stop them.

import type { GitClient } from "../git/index.js";
import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFactory,
  WorkspaceModuleFunctions,
  WorkspaceModuleHost,
  WorkspaceRuntimeValue,
} from "../runtime/types.js";

const NETWORK_COMMANDS = new Set(["clone", "fetch", "pull", "push", "ls-remote", "submodule"]);

/** Options for {@link createGitModule}. */
export interface GitModuleOptions {
  /**
   * Allow `clone` and network `cli` commands such as `fetch` and `push`.
   * Defaults to `false`. These requests run from the host, so the
   * JavaScript backend's egress settings do not apply to them.
   */
  readonly allowNetwork?: boolean;
}

/**
 * Build the `ws:git` host module over the Workspace's Git client.
 *
 * It exports `clone`, `diff`, `status`, `log`, and `cli`. Each takes the
 * same options object as the matching `GitClient` method, with `dir` or
 * `cwd` resolved against the backend root.
 *
 * @param options - Whether network commands are allowed.
 * @returns The module to pass as `modules["ws:git"]`.
 */
export function createGitModule(options: GitModuleOptions = {}): WorkspaceModuleFactory {
  const allowNetwork = options.allowNetwork ?? false;
  const requireNetwork = (operation: string) => {
    if (!allowNetwork) {
      throw new Error(`${operation} requires createGitModule({ allowNetwork: true }).`);
    }
  };

  const create = (host: WorkspaceModuleHost): WorkspaceModuleFunctions => ({
    async clone([value], context) {
      requireWrite(context, "Git clone");
      requireNetwork("Git clone");
      // SAFETY: The isolate's options object passes through to the Git client, as it did when ws:git was built in. The client checks its own options; only the path is rewritten here.
      return host.git.clone(
        (await withDir(value, context, true)) as unknown as Parameters<GitClient["clone"]>[0],
      );
    },
    async diff([value], context) {
      // SAFETY: As for clone.
      return host.git.diff((await withDir(value, context)) as Parameters<GitClient["diff"]>[0]);
    },
    async status([value], context) {
      // SAFETY: As for clone.
      return host.git.status((await withDir(value, context)) as Parameters<GitClient["status"]>[0]);
    },
    async log([value], context) {
      // SAFETY: As for clone.
      return host.git.log((await withDir(value, context)) as Parameters<GitClient["log"]>[0]);
    },
    async cli([value], context) {
      requireWrite(context, "Git CLI");
      // SAFETY: As for clone.
      const input = (value ?? {}) as unknown as Parameters<GitClient["cli"]>[0];
      assertSafeCliArguments(input.argv);
      if (input.argv?.some((argument) => NETWORK_COMMANDS.has(argument.toLowerCase()))) {
        requireNetwork("Git CLI network command");
      }
      return host.git.cli({
        ...input,
        cwd: await context.resolvePath(input.cwd ?? ".", { allowMissing: true }),
      });
    },
  });
  return Object.assign(create, {
    description: `The workspace's Git repository tools: \`status({ dir })\`, \`diff({ dir })\`, \`log({ dir, depth })\`, \`clone({ url, dir })\`, and \`cli({ argv, cwd })\` for any other git subcommand.${allowNetwork ? "" : " Network commands such as clone, fetch, and push are not allowed."}`,
  });
}

function requireWrite(context: WorkspaceModuleCallContext, operation: string) {
  if (context.access !== "read-write") {
    throw new Error(`${operation} requires Workspace write access.`);
  }
}

async function withDir(
  value: WorkspaceRuntimeValue | undefined,
  context: WorkspaceModuleCallContext,
  allowMissing = false,
): Promise<Record<string, WorkspaceRuntimeValue>> {
  const options = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ...options,
    dir: await context.resolvePath(typeof options.dir === "string" ? options.dir : ".", {
      allowMissing,
    }),
  };
}

// Git path overrides would let a command escape the confined directory.
function assertSafeCliArguments(argv: string[] | undefined) {
  if (
    argv?.some(
      (argument) =>
        argument === "-C" ||
        argument.startsWith("-C") ||
        argument === "--git-dir" ||
        argument.startsWith("--git-dir=") ||
        argument === "--work-tree" ||
        argument.startsWith("--work-tree="),
    )
  ) {
    throw new Error(
      "Git CLI path overrides are not available inside a confined Workspace runtime.",
    );
  }
}
