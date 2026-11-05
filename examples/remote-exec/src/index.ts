/**
 * The remote exec example: codemode (computer's CodemodeBackend) calling `codemode:exec` from
 * `@cloudflare/computer/remote-exec`, which runs commands in a real container through
 * `ctx.container.exec()`, with push and pull against a computer workspace. See ../README.md.
 *
 *   PUT  /s/:session/files/<path>   write a workspace file (body = contents)
 *   GET  /s/:session/files/<path>   read a workspace file
 *   POST /s/:session/run            run a codemode module (body = source); returns the result
 *   POST /s/:session/run-read       the same, as a read-only agent: on a backend that only reads
 *   POST /s/:session/exec           direct remote exec from the Worker (body = JSON { argv, ...options })
 *   DELETE /s/:session              destroy the session's container
 */
import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import {
  bundledRemoteExec,
  createExecModule,
  DEFAULT_AGENT_PATH,
  ensureRemoteExec,
  ExecSandbox,
  FACADE_SOURCE,
  FACADE_SPECIFIER,
  remoteExec,
  type ExecTarget,
} from "@cloudflare/computer/remote-exec";
// Both remote-exec builds, from the GitHub release (scripts/fetch-remote-exec.sh). The Worker
// copies the right one into the container on first use; an image that has remote-exec already
// wouldn't need them.
import aarch64 from "../bin/remote-exec-linux-aarch64.bin";
import x86_64 from "../bin/remote-exec-linux-x86_64.bin";

const REMOTE_EXEC_BINARIES = bundledRemoteExec({ x86_64, aarch64 });

interface Env {
  SANDBOX: DurableObjectNamespace<Sandbox>;
  WORKSPACE: DurableObjectNamespace<WorkspaceObject>;
  LOADER: WorkerLoader;
}

/** The container: `sleep infinity`, commands arrive through exec(). */
export class Sandbox extends ExecSandbox<Env> {
  protected startOptions() {
    return { enableInternet: false };
  }
}

const RUN_TIMEOUT_MS = 120_000;

const BACKENDS = { "read-write": "codemode", read: "codemode-read" } as const;

export class WorkspaceObject extends DurableObject<Env> {
  readonly #workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#workspace = new Workspace({
      storage: ctx.storage,
      sessionId: ctx.id.toString(),
      backends: (["read-write", "read"] as const).map(
        (access) =>
          new CodemodeBackend({
            id: BACKENDS[access],
            loader: env.LOADER as never,
            root: "/",
            access,
            modules: {
              "codemode:exec": createExecModule({
                target: () => this.#target(),
                fs: () => this.#workspace.fs,
                binaries: REMOTE_EXEC_BINARIES,
                runTimeoutMs: RUN_TIMEOUT_MS,
                readOnly: access === "read",
              }),
              [FACADE_SPECIFIER]: FACADE_SOURCE,
            },
            defaultTimeoutMs: RUN_TIMEOUT_MS,
            maxTimeoutMs: RUN_TIMEOUT_MS,
          }),
      ),
    });
  }

  #target(): ExecTarget {
    return this.env.SANDBOX.get(
      this.env.SANDBOX.idFromName(this.ctx.id.toString()),
    ) as unknown as ExecTarget;
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    await this.#workspace.ready();
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) await this.#workspace.fs.mkdir(dir, { recursive: true });
    await this.#workspace.fs.writeFile(path, data);
  }

  async readFile(path: string): Promise<string | null> {
    await this.#workspace.ready();
    try {
      return await this.#workspace.fs.readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  async run(source: string, access: keyof typeof BACKENDS) {
    await this.#workspace.ready();
    const handle = await this.#workspace.runtime.exec(source, {
      backend: BACKENDS[access],
      encoding: "utf8",
    });
    const result = await handle.result();
    return {
      status: result.status,
      exitCode: result.exitCode,
      value: result.value ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /** The DO-side API directly, with raw streams: no codemode in between. */
  async directExec(
    argv: string[],
    options: { push?: string[]; pull?: string[]; stdin?: string; cwd?: string; user?: string },
  ) {
    await this.#workspace.ready();
    const installed = await ensureRemoteExec(
      this.#target(),
      DEFAULT_AGENT_PATH,
      REMOTE_EXEC_BINARIES,
    );
    const proc = await remoteExec({ target: this.#target(), fs: this.#workspace.fs }, argv, {
      ...options,
      stdin: options.stdin === undefined ? undefined : new Blob([options.stdin]).stream(),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : "",
      proc.stderr ? new Response(proc.stderr).text() : "",
      proc.exitCode,
    ]);
    return {
      installed,
      pid: proc.pid,
      exitCode,
      stdout,
      stderr,
      pushed: proc.pushed,
      pulled: await proc.pulled,
    };
  }

  async destroy(): Promise<void> {
    await (this.#target() as unknown as Sandbox).destroy();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = /^\/s\/([A-Za-z0-9_-]+)(?:\/(files\/(.+)|run|run-read|exec))?$/.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    // RPC's inferred types can't follow `run`'s any-JSON result; the stub's API, plainly:
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(m[1] ?? "")) as unknown as {
      writeFile(path: string, data: Uint8Array): Promise<void>;
      readFile(path: string): Promise<string | null>;
      run(source: string, access: "read-write" | "read"): Promise<unknown>;
      directExec(argv: string[], options: object): Promise<unknown>;
      destroy(): Promise<void>;
    };
    try {
      if (m[2] === undefined) {
        if (request.method !== "DELETE") return new Response("not found", { status: 404 });
        await stub.destroy();
        return new Response(null, { status: 204 });
      }
      if (m[3] !== undefined) {
        const path = `/workspace/${m[3]}`;
        if (request.method === "PUT") {
          await stub.writeFile(path, new Uint8Array(await request.arrayBuffer()));
          return new Response(null, { status: 204 });
        }
        const text = await stub.readFile(path);
        return text === null ? new Response("not found", { status: 404 }) : new Response(text);
      }
      if (m[2] === "run" || m[2] === "run-read") {
        const access = m[2] === "run" ? "read-write" : "read";
        return Response.json(await stub.run(await request.text(), access));
      }
      const { argv, ...options } = (await request.json()) as { argv: string[] };
      return Response.json(await stub.directExec(argv, options));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
        { status: 500 },
      );
    }
  },
};
