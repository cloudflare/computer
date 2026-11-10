/**
 * The remote exec example: codemode (computer's CodemodeBackend) calling `codemode:exec` from
 * `@cloudflare/computer/remote-exec`, which runs commands in a real container through
 * `ctx.container.exec()`, with push and pull against a computer workspace. See ../README.md.
 *
 *   PUT  /s/:session/files/<path>   write a workspace file (body = contents)
 *   GET  /s/:session/files/<path>   read a workspace file
 *   POST /s/:session/run            run a codemode module (body = source); returns the result
 *   POST /s/:session/run-read       the same, as a read-only agent: on a backend that only reads
 *   DELETE /s/:session              destroy the session's container
 */
import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import {
  createExecModule,
  type ExecArgs,
  executor,
  fileRemoteExec,
} from "@cloudflare/computer/remote-exec";

interface Env {
  SANDBOX: DurableObjectNamespace<Sandbox>;
  WORKSPACE: DurableObjectNamespace<WorkspaceObject>;
  LOADER: WorkerLoader;
}

/** The container: `sleep infinity`, with commands arriving through exec(). */
export class Sandbox extends DurableObject<Env> {
  #executor = executor(this, { enableInternet: false });

  exec(...args: ExecArgs) {
    return this.#executor.exec(...args);
  }

  destroy() {
    return this.#executor.destroy();
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
                // One container for each workspace.
                target: () => env.SANDBOX.getByName(ctx.id.toString()),
                fs: () => this.#workspace.fs,
                // The x86_64 build (scripts/fetch-remote-exec.sh): the container is linux/amd64,
                // as Cloudflare runs it and wrangler dev builds it. wrangler.jsonc uploads it as a
                // module of its own, which workerd shows under /bundle, and node:fs streams it into
                // the container on first use, so the Worker never holds it in memory.
                binaries: fileRemoteExec({ x86_64: "/bundle/remote-exec" }),
                readOnly: access === "read",
              }),
            },
            defaultTimeoutMs: RUN_TIMEOUT_MS,
            maxTimeoutMs: RUN_TIMEOUT_MS,
          }),
      ),
    });
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

  async destroy(): Promise<void> {
    await this.env.SANDBOX.getByName(this.ctx.id.toString()).destroy();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = /^\/s\/([A-Za-z0-9_-]+)(?:\/(files\/(.+)|run|run-read))?$/.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    // RPC's inferred types can't follow `run`'s any-JSON result; the stub's API, plainly:
    const stub = env.WORKSPACE.getByName(m[1] ?? "") as unknown as {
      writeFile(path: string, data: Uint8Array): Promise<void>;
      readFile(path: string): Promise<string | null>;
      run(source: string, access: "read-write" | "read"): Promise<unknown>;
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
      const access = m[2] === "run" ? "read-write" : "read";
      return Response.json(await stub.run(await request.text(), access));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
        { status: 500 },
      );
    }
  },
};
