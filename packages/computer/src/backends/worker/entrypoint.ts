// ShellWorker — the WorkerEntrypoint a user Worker exposes for
// the WorkerBackend in @cloudflare/computer to call.
//
// Each exec call independently reaches the host Workspace
// through a DurableObjectNamespace binding wired into env by
// the Worker Loader callback the host DO supplied. No state
// survives across exec calls: each builds its own Bash
// instance, its own WorkspaceFsAdapter, and disposes the
// workspace stub when the run settles. The only shared per-execution state is
// an AbortController map keyed by explicit execution id so timeout and kill
// requests can cooperatively stop just-bash at statement boundaries.
//
// That shape matters for two reasons. First, the workspace
// reach happens on the user Worker's side, so every fs RPC the
// shell makes lands in the host DO's own request context —
// where the DO's storage handles are valid. Second, two
// concurrent execs in the same isolate each get their own
// workspace stub; there's no shared instance state to race.

import { WorkerEntrypoint } from "cloudflare:workers";
import { Bash, type CustomCommand } from "just-bash";

import { WorkspaceFsAdapter } from "./adapter.js";
import { type ArtifactsCommandHost, defineArtifactsCommand } from "./artifacts-command.js";
import { type AssetsCommandHost, defineAssetsCommand } from "./assets-command.js";
import { defineGitCommand, type GitCommandHost } from "./git-command.js";

export interface ExecInput {
  command: string;
  cwd?: string;
  id?: string;
  timeoutMs?: number;
}

export interface ShellWorkerOptions {
  // Default working directory for spawned Bash instances.
  // Defaults to "/workspace" — the same mount root the existing
  // container backend uses, so scripts that hard-code that path
  // keep working.
  cwd?: string;
}

// Env shape the host Worker is expected to wire through the
// Loader callback. The shell calls env.HOST.getWorkspace() on
// every exec; no caching.
export interface ShellWorkerEnv {
  // Fetcher pointing at a WorkspaceServiceProxy WorkerEntrypoint
  // on the host side. Its getWorkspace() method does the
  // DurableObjectNamespace lookup and returns a WorkspaceStub.
  // A raw DurableObjectNamespace can't be passed through the
  // Loader's env (structured clone doesn't carry it); a
  // WorkerEntrypoint-derived Fetcher does, because the runtime
  // serializes it as a binding reference.
  HOST: ShellHostFetcher;
}

// Subset of the WorkspaceServiceProxy Fetcher the shell uses.
// Declared structurally so tests can swap in a fake.
export interface ShellHostFetcher {
  getWorkspace(): Promise<HostWorkspaceStub>;
}

// The shape getWorkspace() returns. The shell touches .fs (for
// the adapter behind every just-bash filesystem call), .git (for
// the `git` custom command), and optionally .assets (for
// `assets publish`). Workers RPC happens to carry this with
// [Symbol.dispose]; the shell disposes it after Bash settles.
export interface HostWorkspaceStub extends GitCommandHost, AssetsCommandHost {
  fs: import("./adapter.js").WorkspaceFs;
  artifacts: ArtifactsCommandHost["artifacts"];
  [Symbol.dispose]?: () => void;
}

const DEFAULT_CWD = "/workspace";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const defenseDebug = console.debug.bind(console);
console.debug = (...args: unknown[]) => {
  if (String(args[0]).startsWith("[DefenseInDepthBox] Could not register import() hooks:")) return;
  defenseDebug(...args);
};

// Wire event shape. Matches @cloudflare/computer-rpc's ExecEvent
// but with stdout/stderr values as utf8 strings (the host-side
// decoder re-encodes to Uint8Array before WorkspaceShell sees
// them).
type WireEvent =
  | { id: string; seq: number; name: "stdout"; value: string }
  | { id: string; seq: number; name: "stderr"; value: string }
  | { id: string; seq: number; name: "exit"; value: number };

export class ShellWorker<
  Env extends ShellWorkerEnv = ShellWorkerEnv,
> extends WorkerEntrypoint<Env> {
  // Subclasses override to change the default cwd.
  // just-bash's Python and JavaScript commands require
  // node:worker_threads and cannot run in workerd.
  protected readonly shellOptions: ShellWorkerOptions = {};
  readonly #executions = new Map<string, AbortController>();

  // Test seam: when set, exec uses this to spawn the command
  // instead of `new Bash({...}).exec(...)`. Real production
  // paths never touch it.
  //
  // The override receives the customCommands list that would
  // have gone into the Bash constructor so tests can assert on
  // it directly — the git command is registered here, and a
  // subclass extraCommands hook would layer onto the same list.
  protected bashFactoryOverride:
    | ((
        command: string,
        options: {
          cwd?: string;
          signal?: AbortSignal;
          customCommands: CustomCommand[];
        },
      ) => Promise<{ stdout: string; stderr: string; exitCode: number }>)
    | undefined;

  /**
   * Subclass hook for registering additional custom commands
   * alongside the built-in `git` command. Symmetric with
   * `shellOptions`: the base class returns an empty list and
   * subclasses override to layer their own commands on top.
   *
   * Called once per `exec` with the live host stub the shell
   * already reached, so subclass commands share that stub's
   * lifetime without needing to refetch.
   */
  protected extraCommands(_ws: HostWorkspaceStub): CustomCommand[] {
    return [];
  }

  override async fetch(_request: Request): Promise<Response> {
    return new Response(
      "ShellWorker is invoked over Workers RPC — dispatch through the Workspace's WorkerBackend.",
      { status: 426, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  async exec(input: ExecInput): Promise<{ id: string; events: ReadableStream<Uint8Array> }> {
    const id = input.id ?? crypto.randomUUID();
    const cwd = input.cwd ?? this.shellOptions.cwd ?? DEFAULT_CWD;
    if (this.#executions.has(id))
      throw createShellError("EEXEC_BUSY", `execution ${id} is running`);
    const controller = new AbortController();
    this.#executions.set(id, controller);
    let timedOut = false;
    const timer =
      input.timeoutMs === undefined || input.timeoutMs === 0
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort(new Error("Execution timed out"));
          }, input.timeoutMs);

    // Reach the host workspace on each call. Concurrent execs get separate
    // stubs; only their cancellation controllers share this entrypoint.
    let ws: HostWorkspaceStub;
    try {
      ws = await this.env.HOST.getWorkspace();
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);
      if (this.#executions.get(id) === controller) this.#executions.delete(id);
      throw error;
    }

    const customCommands: CustomCommand[] = [
      defineGitCommand(ws),
      defineAssetsCommand(ws),
      defineArtifactsCommand({ artifacts: ws.artifacts, git: ws.git }),
      ...this.extraCommands(ws),
    ];

    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      if (this.bashFactoryOverride !== undefined) {
        result = await this.bashFactoryOverride(input.command, {
          cwd,
          signal: controller.signal,
          customCommands,
        });
      } else {
        const bash = new Bash({
          fs: new WorkspaceFsAdapter(ws.fs) as unknown as NonNullable<
            ConstructorParameters<typeof Bash>[0]
          >["fs"],
          cwd,
          customCommands,
          // just-bash's in-process DefenseInDepthBox activates by
          // registering ESM loader hooks through node:module's
          // registerHooks. workerd exposes that method but throws
          // "not implemented", so activation aborts and every
          // command fails. The box is redundant here anyway: the
          // shell already runs inside an isolated Dynamic Worker,
          // which is the real boundary. Opt out so the interpreter
          // runs on the workerd target.
          defenseInDepth: { enabled: false },
          executionLimits: { maxOutputSize: MAX_OUTPUT_BYTES },
        });
        result = await bash.exec(input.command, { cwd, signal: controller.signal });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        stdout: "",
        stderr: `${timedOut ? "Execution timed out" : message}\n`,
        exitCode: timedOut ? 124 : controller.signal.aborted ? 130 : 1,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (this.#executions.get(id) === controller) this.#executions.delete(id);
      // Dispose the workspace stub after Bash has fully settled.
      // Bash held a reference to the adapter for the duration of
      // the exec; once .exec resolves the adapter's underlying
      // stub is no longer needed.
      try {
        ws[Symbol.dispose]?.();
      } catch {
        // already disposed
      }
    }

    const events: WireEvent[] = [];
    let seq = 0;
    if (result.stdout.length > 0) {
      events.push({ id, seq: ++seq, name: "stdout", value: result.stdout });
    }
    if (result.stderr.length > 0) {
      events.push({ id, seq: ++seq, name: "stderr", value: result.stderr });
    }
    events.push({ id, seq: ++seq, name: "exit", value: result.exitCode });
    return { id, events: framedStream(events) };
  }

  async getExec(input: { id: string }): Promise<{
    id: string;
    events: ReadableStream<Uint8Array>;
  }> {
    // The shell holds no per-call state across requests; an
    // exec id seen on this isolate is never reachable from a
    // later getExec because each call is its own scope. Return
    // ENOENT so consumers see a consistent failure shape.
    throw createShellError("ENOENT", `no such exec: ${input.id}`);
  }

  async killExec(input: {
    id: string;
    signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
  }): Promise<void> {
    this.#executions
      .get(input.id)
      ?.abort(new Error(`Execution cancelled with ${input.signal ?? "SIGTERM"}`));
  }
}

function framedStream(events: WireEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
}

function createShellError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = "ShellWorkerError";
  error.code = code;
  return error;
}
