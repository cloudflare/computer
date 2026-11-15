// The Worker shell's `git`, `assets` and `artifacts` commands, as JS programs
// on a Kitebuild machine. Both call clients on the Workspace host, which
// read and write the Workspace store outside the machine, so the
// programs commit the machine's buffered writes first and apply what
// the call changed to the mounts afterwards.

import { currentRev } from "@cloudflare/dofs";
import type { JsProgramCtx, ProgramSpec } from "@cloudflare/kitebuild-core";

import type { WorkspaceBackendHost } from "../../backend";
import {
  type CommandResult,
  runArtifactsCommand,
  runAssetsCommand,
  runGitCommand,
} from "../workspace-commands";
import { EPIPE, readAll, writeAll } from "./fd-io";

export interface WorkspaceCommandsHost {
  readonly host: WorkspaceBackendHost;
  /** Whether to include `git` backed by the Workspace's git client. */
  readonly git: boolean;
  /** Commit the mounts' buffered writes to the Workspace store. */
  flush(): void;
  /** Apply Workspace paths changed after store revision `since` to the mounts. */
  refreshAfter(since: number): Promise<void>;
}

export function workspacePrograms({
  host,
  git,
  flush,
  refreshAfter,
}: WorkspaceCommandsHost): ProgramSpec[] {
  // Commit the machine's writes, run `call` against the host, and apply
  // whatever it changed in the store to the mounts.
  const throughHost = async (call: () => Promise<CommandResult>): Promise<CommandResult> => {
    flush();
    const before = currentRev(host.db);
    const result = await call();
    if (currentRev(host.db) !== before) await refreshAfter(before);
    return result;
  };

  const workspaceGit: ProgramSpec = {
    // A git toolset registers after and replaces it.
    path: "/usr/bin/git",
    abi: "js",
    main: async (ctx) => {
      const args = ctx.argv.slice(1);
      // Read stdin only when git will use it, as real git does: a pipe
      // whose writer never stops would otherwise keep git waiting.
      const stdin = args.includes("--stdin") ? await readAll(ctx, 0) : undefined;
      // Stopped, or the read failed: run nothing on partial input.
      if (stdin === null) return 1;
      return write(
        ctx,
        await throughHost(() =>
          runGitCommand(host.git, args, ctx.proc.cwd, environment(ctx.envp), stdin),
        ),
      );
    },
  };

  return [
    ...(git ? [workspaceGit] : []),
    {
      path: "/usr/bin/assets",
      abi: "js",
      main: async (ctx) => {
        const assets = host.assets;
        const publish =
          assets &&
          ((path: string, options: { expiresAfter: number }) => {
            flush();
            return assets.share(path, options);
          });
        return write(ctx, await runAssetsCommand(ctx.argv.slice(1), ctx.proc.cwd, publish));
      },
    },
    {
      path: "/usr/bin/artifacts",
      abi: "js",
      main: async (ctx) => {
        // The create shorthand adds a git remote through the host.
        const result = await throughHost(() =>
          runArtifactsCommand(host, ctx.argv.slice(1), ctx.proc.cwd, environment(ctx.envp)),
        );
        return write(ctx, result);
      },
    },
  ];
}

function environment(envp: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of envp) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

// Writes a command's output and returns its exit code, or 141, as for
// SIGPIPE, when the reader has gone, or 1 when the output could not be
// written for another reason.
async function write(ctx: JsProgramCtx, result: CommandResult): Promise<number> {
  for (const [fd, text] of [
    [1, result.stdout],
    [2, result.stderr],
  ] as const) {
    const failed = await writeAll(ctx, fd, new TextEncoder().encode(text));
    if (failed === -EPIPE) return 141;
    if (failed < 0) return 1;
  }
  return result.exitCode;
}
