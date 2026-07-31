import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { IsolateJavaScriptBackend } from "../src/backends/javascript/index.js";
import { createGitClient } from "../src/git/index.js";
import type {
  DurableObjectStorageLike,
  WorkspaceRuntimeValue,
  WorkspaceStub,
} from "../src/index.js";
import { Workspace } from "../src/index.js";

export interface Env {
  HOST: DurableObjectNamespace<HostDO>;
  LOADER: WorkerLoader;
}

export class HostDO extends DurableObject<Env> {
  readonly #workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#workspace = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      waitUntil: ctx.waitUntil.bind(ctx),
      git: createGitClient(),
      backends: [
        new IsolateJavaScriptBackend({
          loader: env.LOADER,
          maxLogBytes: 64,
          maxLogEvents: 4,
          maxCapabilityBytes: 1024,
          maxConcurrentCapabilityCalls: 2,
          modules: {
            "math-kit": "export const double = (value) => value * 2;",
          },
          trustedModules: {
            "ws:test-host": {
              async call(method, args) {
                if (method === "invalid-result") return new Date() as never;
                if (method === "large-error") throw new Error("x".repeat(5000));
                if (method === "slow") {
                  await new Promise((resolve) => setTimeout(resolve, 20));
                  return null;
                }
                if (method === "marker") {
                  return {
                    __workspace_codec__: { version: 1, type: "bytes", data: [1] },
                    keep: true,
                  };
                }
                return { method, args };
              },
            },
          },
        }),
      ],
    });
  }

  async writeFile(path: string, source: string) {
    await this.#workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/workspace", {
      recursive: true,
    });
    await this.#workspace.fs.writeFile(path, source);
  }

  async symlink(target: string, path: string) {
    await this.#workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", {
      recursive: true,
    });
    await this.#workspace.fs.symlink(target, path);
  }

  getWorkspace(): WorkspaceStub {
    return this.#workspace.stub();
  }

  readFile(path: string) {
    return this.#workspace.fs.readFile(path, "utf8");
  }

  async runRuntime(input: {
    source: string;
    cwd?: string;
    value?: WorkspaceRuntimeValue;
    id?: string;
  }) {
    await this.#workspace.fs.mkdir("/workspace", { recursive: true });
    const handle = await this.#workspace.runtime.exec(input.source, {
      backend: "isolate-javascript",
      cwd: input.cwd,
      input: input.value,
      id: input.id,
      encoding: "utf8",
    });
    return { id: handle.id, result: await handle.result() };
  }

  async startRuntime(input: { source: string; id: string }) {
    await this.#workspace.fs.mkdir("/workspace", { recursive: true });
    const handle = await this.#workspace.runtime.exec(input.source, {
      backend: "isolate-javascript",
      id: input.id,
    });
    void handle.result().catch(() => undefined);
    return handle.id;
  }

  async getRuntime(id: string, resume?: "tail") {
    try {
      const handle = await this.#workspace.runtime.getExec(id, {
        backend: "isolate-javascript",
        encoding: "utf8",
        resume,
      });
      return { ok: true as const, result: await handle.result() };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  killRuntime(id: string) {
    return this.#workspace.runtime.killExec(id, { backend: "isolate-javascript" });
  }

  disposeRuntime(id: string) {
    return this.#workspace.runtime.disposeExec(id, { backend: "isolate-javascript" });
  }
}

class ModuleProbeBridge extends RpcTarget {
  read(path: string): string {
    return `host:${path}`;
  }
}

export default class extends WorkerEntrypoint<Env> {
  override async fetch(request: Request) {
    const url = new URL(request.url);
    const stub = this.env.HOST.get(this.env.HOST.idFromName("script-runner"));

    try {
      if (url.pathname === "/module-probe") {
        const worker = this.env.LOADER.load({
          compatibilityDate: "2026-06-17",
          compatibilityFlags: ["nodejs_compat"],
          mainModule: "runner.js",
          modules: {
            "runner.js": `
              import { WorkerEntrypoint } from "cloudflare:workers";
              import { install } from "workspace:capabilities";
              export default class extends WorkerEntrypoint {
                async evaluate(bridge) {
                  install(bridge);
                  globalThis.__probeBridge = bridge;
                  const user = await import("./user.js");
                  return user.default();
                }
              }
            `,
            "workspace:capabilities": {
              js: `
                let bridge;
                export function install(value) { bridge = value; }
                export function call(name, ...args) {
                  if (!bridge) throw new Error("Workspace capabilities are not installed");
                  return bridge[name](...args);
                }
              `,
            },
            "node:fs/promises": {
              js: `
                export const tag = "trusted";
                export function readFile(path) { return globalThis.__probeBridge.read(path); }
              `,
            },
            "helper.js": `export const suffix = "relative";`,
            "user.js": `
              import { readFile } from "node:fs/promises";
              import { suffix } from "./helper.js";
              export default async function run() {
                const dynamic = await import("node:fs/promises");
                return [await readFile("/workspace/probe.txt"), suffix, dynamic.tag].join("|");
              }
            `,
          },
          globalOutbound: null,
        });
        const entrypoint = worker.getEntrypoint() as unknown as {
          evaluate(bridge: ModuleProbeBridge): Promise<string>;
          [Symbol.dispose]?: () => void;
        };
        try {
          return new Response(await entrypoint.evaluate(new ModuleProbeBridge()));
        } finally {
          entrypoint[Symbol.dispose]?.();
          (worker as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
        }
      }
      if (url.pathname === "/runtime") {
        return Response.json(
          await stub.runRuntime(
            (await request.json()) as {
              source: string;
              cwd?: string;
              value?: WorkspaceRuntimeValue;
              id?: string;
            },
          ),
        );
      }

      if (url.pathname === "/runtime-start") {
        return Response.json({
          id: await stub.startRuntime((await request.json()) as { source: string; id: string }),
        });
      }

      if (url.pathname === "/runtime-get") {
        const response = await stub.getRuntime(
          url.searchParams.get("id") ?? "missing",
          url.searchParams.get("resume") === "tail" ? "tail" : undefined,
        );
        return response.ok
          ? Response.json(response.result)
          : Response.json({ error: response.error }, { status: 400 });
      }

      if (url.pathname === "/runtime-kill") {
        await stub.killRuntime(url.searchParams.get("id") ?? "missing");
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/runtime-dispose") {
        await stub.disposeRuntime(url.searchParams.get("id") ?? "missing");
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/write") {
        await stub.writeFile(
          url.searchParams.get("path") ?? "/workspace/script.js",
          await request.text(),
        );
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/symlink") {
        await stub.symlink(
          url.searchParams.get("target") ?? "/outside-secret.txt",
          url.searchParams.get("path") ?? "/workspace/outside-link",
        );
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/read") {
        return new Response(
          await stub.readFile(url.searchParams.get("path") ?? "/workspace/result.txt"),
        );
      }

      return new Response("not found", { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  }
}
