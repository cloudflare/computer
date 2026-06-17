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
// behavioral choice live in `artifacts/cli.ts`; this file only
// adapts the just-bash `Command` signature to the
// `ArtifactsCLIInput` / `ArtifactsCLIResult` shape the client
// exposes.

import { type CustomCommand, defineCommand } from "just-bash";

import type { ArtifactsCLIInput, ArtifactsCLIResult } from "../../artifacts/index.js";

/** Structural subset of the host the command needs. */
export interface ArtifactsCommandHost {
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

    try {
      const result = await host.artifacts.cli({ argv: args, env });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    } catch (cause) {
      // The CLI dispatcher catches its own subcommand failures and
      // returns them as { exitCode } results. A throw here means the
      // RPC itself failed (transport hiccup, host client gone) —
      // surface that as exit 1 with the message on stderr so the
      // shell sees a normal command failure rather than crashing the
      // pipeline.
      const message = cause instanceof Error ? cause.message : String(cause);
      return { stdout: "", stderr: `artifacts: ${message}\n`, exitCode: 1 };
    }
  });
}
