// `git` custom command for the worker-backend's shell isolate.
//
// The shell runs in a Dynamic Worker that has no network access of
// its own (the loader sets `globalOutbound: null` — see worker.ts).
// Every `git` invocation here forwards across the loopback to the
// host DO's `workspace.git.cli(...)`. The actual fetch happens on
// the DO side, which is fine: network-bound subcommands (`clone`,
// `fetch`, `pull`, `push`) work even though the shell isolate
// cannot itself reach the wire.
//
// Keeping this file dumb is deliberate. Argv parsing and every
// behavioural choice for the CLI lives in `git/cli.ts`; this
// file only adapts the just-bash `Command` signature to the
// `GitCliInput` / `GitCliResult` shape the host stub exposes. If
// the JS API and the CLI ever drift, it is because someone
// changed `git/cli.ts`, not because they touched this shim.

import { type CustomCommand, defineCommand } from "just-bash";

// `ByteString` is just-bash's opaque tag over a latin1 byte buffer
// (each JS char is one byte, 0–255). Reach into the buffer through
// `String.prototype.charCodeAt` and feed it into TextDecoder. We
// can't import just-bash's `decodeBytesToUtf8` directly because the
// browser bundle the workspace bundle ends up resolving against
// (esbuild picks `browser` over `worker` for the workspace's
// downstream consumers) doesn't re-export it. Same semantics:
// decode as UTF-8, fall back to the raw latin1 view on invalid
// bytes so binary stdin still survives a pipeline.
const UTF8_DECODER = /* @__PURE__ */ new TextDecoder("utf-8", { fatal: true });
function decodeLatin1ToUtf8(b: string): string {
  if (!b) return b;
  let hasHighBit = false;
  for (let i = 0; i < b.length; i++) {
    const code = b.charCodeAt(i);
    // A char above 0xff means somebody handed us real text, not a
    // ByteString. Pass it through unchanged — mirrors just-bash's
    // own guard.
    if (code > 0xff) return b;
    if (code > 0x7f) hasHighBit = true;
  }
  // Pure-ASCII byte buffers are already valid UTF-8; skip the
  // round-trip.
  if (!hasHighBit) return b;
  const bytes = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return b;
  }
}

import type { GitCliInput, GitCliResult } from "../../git/index.js";

/** Structural subset of the host stub the command needs. */
export interface GitCommandHost {
  git: {
    cli(input: GitCliInput): Promise<GitCliResult>;
  };
}

/**
 * Build a `git` custom command bound to a host workspace stub.
 *
 * Forwards argv, cwd, env, and stdin to the host's
 * `workspace.git.cli(...)`. The env Map from `CommandContext` is
 * flattened into a plain object on the way through — the wire
 * carries JSON, and the CLI dispatcher only reads `GIT_AUTHOR_*` /
 * `GIT_COMMITTER_*` from it today.
 *
 * The closure captures `ws` for the duration of `bash.exec`. The
 * caller (`ShellWorker.exec`) keeps `ws` alive until Bash settles
 * via the existing `finally` block; there's no new disposal
 * contract here.
 */
export function defineGitCommand(ws: GitCommandHost): CustomCommand {
  return defineCommand("git", async (args, ctx) => {
    // Bash gives us the env as a Map<string, string>. The CLI
    // dispatcher takes a plain Record<string, string>; flatten
    // once here so the CLI doesn't have to care.
    const env: Record<string, string> = {};
    for (const [k, v] of ctx.env) env[k] = v;

    try {
      const result = await ws.git.cli({
        argv: args,
        cwd: ctx.cwd,
        env,
        // ByteString is structurally a string; the opaque tag is
        // type-only. Cast through unknown to satisfy the decoder.
        stdin: decodeLatin1ToUtf8(ctx.stdin as unknown as string),
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    } catch (cause) {
      // The CLI dispatcher catches its own subcommand failures and
      // returns them as { exitCode: 1 } results. A throw here means
      // the RPC itself failed (transport hiccup, host stub gone) —
      // surface that as exit 1 with the message on stderr so the
      // shell sees a normal command failure rather than crashing
      // the whole pipeline.
      const message = cause instanceof Error ? cause.message : String(cause);
      return { stdout: "", stderr: `git: ${message}\n`, exitCode: 1 };
    }
  });
}
