// `artifacts` custom command for the worker-backend's shell isolate.
//
// The shell runs in a Dynamic Worker with no network access of its
// own (the loader sets `globalOutbound: null` — see worker.ts).
// Every `artifacts` invocation here forwards to a host-side
// artifacts client's `cli(...)`, where the real Artifacts binding
// lives. The host call does the network work; the shell only needs
// to reach it over the loopback.
//
// This is the artifacts analogue of `defineGitCommand`. The `git`
// command reaches the workspace stub; `artifacts` reaches an
// optional host method that owns the consumer-supplied Artifacts
// binding.
//
// Keeping this file clean is deliberate. Argv parsing and every
// behavioral choice live in `artifacts/cli.ts`, and the bridge to the
// client in `../workspace-commands.ts`, shared with other shells;
// this file only adapts the just-bash `Command` signature.

import { type CustomCommand, defineCommand } from "just-bash";

import type { ArtifactsCLIInput, ArtifactsCLIResult } from "../../artifacts/index";
import { runArtifactsCommand } from "../workspace-commands";
import type { GitCommandHost } from "./git-command";

/**
 * Structural subset of the host the command needs. It owns the
 * artifacts client and the workspace git CLI: the `create` shorthand
 * registers a git remote, and the artifacts package has no git of its
 * own, so the command bridges the two by handing the artifacts CLI a
 * `remoteAdd` closure backed by `git.cli(...)`.
 */
export interface ArtifactsCommandHost extends GitCommandHost {
  artifacts: {
    cli(input: ArtifactsCLIInput): Promise<ArtifactsCLIResult>;
  };
}

/**
 * Build an `artifacts` custom command bound to a host artifacts
 * client.
 *
 * Forwards argv and env to the client's `cli(...)`. The env Map
 * from `CommandContext` is flattened into a plain object on the way
 * through. The artifacts CLI does not read stdin, so it is dropped.
 */
export function defineArtifactsCommand(host: ArtifactsCommandHost): CustomCommand {
  return defineCommand("artifacts", async (args, ctx) => {
    const env: Record<string, string> = {};
    for (const [k, v] of ctx.env) env[k] = v;
    return runArtifactsCommand(host, args, ctx.cwd, env);
  });
}
