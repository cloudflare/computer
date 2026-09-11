// The code surface a container process reaches by dialing the host's
// egress endpoint at /codemode.
//
// Each CLI invocation opens one WebSocket, which becomes one capnweb
// session whose bootstrap stub is a CodemodeRPCTarget. The target
// wraps a codemode runtime built from the connectors the backend was
// configured with; the runtime facet is durable, so executions and
// snippets accumulate across sessions while the connectors and the
// dynamic-worker executor are rebuilt per session.
//
// RpcTarget comes from capnweb rather than `cloudflare:workers` for
// the same reason as stub.ts: the class must resolve under node so the
// unit tests can construct it, and on workerd the two are aliases.
//
// @cloudflare/codemode is an optional peer dependency. It is imported
// lazily, so a consumer that never configures the codemode option does
// not need it installed, and the node test runner never loads a module
// that imports `cloudflare:workers` at its top level.

import type {
  CodemodeDescription,
  CodemodePendingAction,
  CodemodeResult,
  CodemodeRPC,
  CodemodeSearch,
  CodemodeTypes,
} from "@cloudflare/computer-rpc";
import { RpcTarget } from "capnweb";

// Path on the egress host the CLI dials. WorkspaceProxy forwards it and
// the container backend answers it, so both read it from here.
export const CODEMODE_PATH = "/codemode";

// The slice of the codemode runtime handle and connector the target
// needs. Structural on purpose: tests substitute fakes, and the
// package does not import the real types at module load.
export interface CodemodeRuntimeLike {
  execute(input: { code: string }): Promise<CodemodeRuntimeOutput>;
  search(query: string): Promise<CodemodeSearch>;
  describe(target: string): Promise<CodemodeDescription>;
  pending(executionId?: string): Promise<CodemodePendingAction[]>;
}

export type CodemodeRuntimeOutput =
  | { status: "completed"; executionId: string; result: unknown; logs?: string[] }
  | { status: "paused"; executionId: string; pending: CodemodePendingAction[] }
  | { status: "error"; executionId: string; error: string; logs?: string[] };

export interface CodemodeConnectorLike {
  name(): string;
  getTypeScriptTypes(): Promise<string>;
}

export class CodemodeRPCTarget extends RpcTarget implements CodemodeRPC {
  readonly #runtime: CodemodeRuntimeLike;
  readonly #connectors: readonly CodemodeConnectorLike[];

  constructor(runtime: CodemodeRuntimeLike, connectors: readonly CodemodeConnectorLike[]) {
    super();
    this.#runtime = runtime;
    this.#connectors = connectors;
  }

  async types(): Promise<CodemodeTypes> {
    const types = await Promise.all(this.#connectors.map((c) => c.getTypeScriptTypes()));
    return {
      types: types.join("\n"),
      connectors: this.#connectors.map((c) => c.name()),
    };
  }

  search(query: string): Promise<CodemodeSearch> {
    return this.#runtime.search(String(query ?? ""));
  }

  describe(target: string): Promise<CodemodeDescription> {
    return this.#runtime.describe(String(target ?? ""));
  }

  // A rejection here would surface as an unhandled rejection on the
  // host rather than as a result the caller can print, so every
  // failure is folded into an "error" result.
  async execute(input: { code: string }): Promise<CodemodeResult> {
    const code = typeof input?.code === "string" ? input.code : "";
    if (code.trim() === "") {
      return { status: "error", executionId: "", error: "no code provided" };
    }
    try {
      const output = await this.#runtime.execute({ code });
      switch (output.status) {
        case "completed":
          return {
            status: "completed",
            executionId: output.executionId,
            result: output.result,
            logs: output.logs,
          };
        case "paused":
          return { status: "paused", executionId: output.executionId, pending: output.pending };
        case "error":
          return {
            status: "error",
            executionId: output.executionId,
            error: output.error,
            logs: output.logs,
          };
      }
    } catch (error) {
      return {
        status: "error",
        executionId: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Read-only on purpose: the container can see why a run stopped but
  // is never handed the decision. See the interface comment.
  pending(executionId?: string): Promise<CodemodePendingAction[]> {
    return this.#runtime.pending(executionId);
  }
}

export interface CodemodeSessionOptions {
  // The Durable Object state that owns the runtime facet.
  ctx: DurableObjectState;
  // Worker Loader binding the dynamic worker is minted from.
  loader: WorkerLoader;
  // Built per session. Anything reachable from the Durable Object can
  // be handed to a connector: `this.env` bindings, `this.ctx.storage`,
  // the workspace itself.
  connectors: () => CodemodeConnectorLike[];
  // Wall-clock limit for one script. Defaults to 60 seconds.
  executionTimeoutMs?: number;
}

const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;

// Builds the bootstrap target for one session. Imports codemode on
// first use; see the module comment.
export async function createCodemodeSession(
  options: CodemodeSessionOptions,
): Promise<CodemodeRPCTarget> {
  const { createCodemodeRuntime, DynamicWorkerExecutor } = await import("@cloudflare/codemode");
  const connectors = options.connectors();
  const runtime = createCodemodeRuntime({
    ctx: options.ctx,
    // The runtime wants the concrete connector class; the structural
    // type above is what the target needs, and every real connector
    // satisfies both.
    connectors: connectors as unknown as Parameters<typeof createCodemodeRuntime>[0]["connectors"],
    executor: new DynamicWorkerExecutor({
      loader: options.loader,
      timeout: options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    }),
  });
  return new CodemodeRPCTarget(runtime, connectors);
}
