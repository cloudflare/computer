import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import {
  DynamicJavaScriptBackend,
  type DynamicJavaScriptBackendOptions,
} from "../src/backends/dynamic-javascript/index.js";
import type { WorkspaceRuntimeValue } from "../src/index.js";
import { Workspace } from "../src/index.js";

export interface Env {
  HOST: DurableObjectNamespace<HostDO>;
  LOADER: WorkerLoader;
}

function backend(
  ctx: DurableObjectState,
  env: Env,
  overrides: Partial<DynamicJavaScriptBackendOptions> = {},
) {
  return new DynamicJavaScriptBackend({
    loader: env.LOADER,
    facets: ctx.facets,
    modules: {
      "math-kit": "export const double = (value) => value * 2;",
      "ws:test-host": {
        async echo(args) {
          return { echoed: [...args] };
        },
      },
    },
    ...overrides,
  });
}

export class HostDO extends DurableObject<Env> {
  readonly #workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#workspace = new Workspace({
      storage: ctx.storage,
      backends: [
        backend(ctx, env),
        backend(ctx, env, { id: "second" }),
        backend(ctx, env, { id: "read-only", access: "read" }),
        backend(ctx, env, { id: "impatient", maxHostCallMs: 300 }),
      ],
    });
  }

  async writeFile(path: string, source: string) {
    await this.#workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", {
      recursive: true,
    });
    await this.#workspace.fs.writeFile(path, source);
  }

  readFile(path: string) {
    return this.#workspace.fs.readFile(path, "utf8");
  }

  description(backendId = "dynamic-javascript") {
    return this.#workspace.runtime.backends().find((entry) => entry.id === backendId)?.description;
  }

  async run(source: string, options: { backend?: string; input?: WorkspaceRuntimeValue } = {}) {
    const handle = await this.#workspace.runtime.exec(source, {
      backend: options.backend ?? "dynamic-javascript",
      cwd: "/workspace",
      input: options.input,
      encoding: "utf8",
    });
    const result = await handle.result();
    return {
      status: result.status,
      exitCode: result.exitCode,
      stderr: result.stderr,
      value: result.value ?? null,
    };
  }
}

export default class extends WorkerEntrypoint<Env> {
  override fetch() {
    return new Response("ok");
  }
}
