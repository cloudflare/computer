// WorkspaceProxy — the WorkerEntrypoint a container DO hands to
// ctx.container.interceptOutboundHttp(...) so computerd can dial back
// into the DO.
//
// Why this exists as a separate class rather than passing the DO
// itself: `interceptOutboundHttp` requires a runtime-wrapped
// binding Fetcher (has `getSubrequestChannel` plumbing the
// platform needs). Plain DO stubs fail that check; only loopback
// bindings produced by `ctx.exports.<ClassName>(...)` for a
// top-level-exported WorkerEntrypoint pass.
//
// Usage shape in user code:
//
//   // Worker entry point — re-export the class so the runtime can
//   // wrap it into a loopback binding.
//   export { WorkspaceProxy } from "@cloudflare/computer";
//
//   class ComputerdContainer extends DurableObject<Env> {
//     constructor(ctx: DurableObjectState, env: Env) {
//       super(ctx, env);
//       this.#backend = new CloudflareContainerBackend({
//         container: () => ctx.container!,
//         egress: ctx.exports.WorkspaceProxy({
//           props: {
//             // Binding name in env that points back at this DO.
//             binding: "COMPUTERD",
//             // The DO instance the upgrade should route to.
//             id: ctx.id.toString(),
//           },
//         }),
//       });
//     }
//
//     override async fetch(req: Request): Promise<Response> {
//       // The DO answers /health (port-readiness poll from the
//       // backend) and /ws (capnweb upgrade) on its own fetch().
//       const url = new URL(req.url);
//       if (url.pathname === "/health") return new Response("ok\n");
//       if (url.pathname === "/ws") return this.#backend.handleFetch(req);
//       return new Response("not found", { status: 404 });
//     }
//   }
//
// `binding` is a string because props travel through structured
// clone and DurableObjectNamespace references aren't clonable. The
// proxy looks up `env[binding]` at fetch time and falls back to a
// clear error if the name doesn't resolve. The DO class doesn't
// need to live in @cloudflare/computer — the proxy works for any
// DO that implements a fetch() handler answering /health and /ws.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

import type { ArtifactsCLIInput, ArtifactsCLIResult } from "./artifacts/index.js";
import { WORKSPACE_EGRESS_TOKEN_HEADER, WORKSPACE_EGRESS_URL_HEADER } from "./runtime/egress.js";

export interface WorkspaceProxyProps {
  // Name of a DurableObjectNamespace binding in env. The proxy
  // resolves `env[binding]` at request time.
  binding: string;
  // Stringified DurableObjectId — typically `ctx.id.toString()`
  // from inside the owning DO's constructor.
  id: string;
  egressToken?: string;
}

export class WorkspaceProxy extends WorkerEntrypoint<unknown, WorkspaceProxyProps> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (this.ctx.props.egressToken !== undefined) {
      const headers = new Headers(request.headers);
      headers.set(WORKSPACE_EGRESS_TOKEN_HEADER, this.ctx.props.egressToken);
      headers.set(WORKSPACE_EGRESS_URL_HEADER, request.url);
      url.pathname = "/ws";
      url.search = "";
      const stub = this.#hostStub();
      if (stub === undefined) return this.#missingBindingResponse();
      return stub.fetch(new Request(url, new Request(request, { headers })));
    }

    const callback = url.pathname.match(/^\/__workspace_connect\/([0-9a-f-]{36})\/(health|ws)$/);
    if (callback?.[2] === "health") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/health") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/ws" || callback?.[2] === "ws") {
      if (callback?.[1]) {
        url.pathname = "/ws";
        url.searchParams.set("token", callback[1]);
        request = new Request(url, request);
      }
      const stub = this.#hostStub();
      if (stub === undefined) return this.#missingBindingResponse();
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  }

  #hostStub(): DurableObjectStub | undefined {
    const { binding, id } = this.ctx.props;
    const ns = (this.env as Record<string, unknown>)[binding] as DurableObjectNamespace | undefined;
    return ns?.get(ns.idFromString(id));
  }

  #missingBindingResponse(): Response {
    return new Response(
      `WorkspaceProxy: env.${this.ctx.props.binding} is not a DurableObjectNamespace`,
      { status: 500 },
    );
  }
}

export class ArtifactsCLITarget extends RpcTarget {
  readonly #cli: (input: ArtifactsCLIInput) => Promise<ArtifactsCLIResult>;

  constructor(cli: (input: ArtifactsCLIInput) => Promise<ArtifactsCLIResult>) {
    super();
    this.#cli = cli;
  }

  cli(input: ArtifactsCLIInput): Promise<ArtifactsCLIResult> {
    return this.#cli(input);
  }
}

// WorkspaceServiceProxy — a loopback WorkerEntrypoint that
// exposes the host DO's Workspace stub as a callable Fetcher
// binding. Wired into a Dynamic Worker's env by a
// Worker Loader callback so the loaded Worker can reach the
// host Workspace without being handed the DO namespace
// directly.
//
// Why this wrapper exists: env values passed to the Worker
// Loader go through structured clone, which a raw
// DurableObjectNamespace doesn't survive. Service-binding-shape
// Fetchers produced by ctx.exports.<EntrypointClass>(...) do
// survive, because the runtime serializes them as binding
// references rather than raw values.
//
// Usage:
//
//   // Worker entry: re-export so the runtime can wrap it.
//   export { WorkspaceServiceProxy } from "@cloudflare/computer";
//
//   // Inside the DO that owns the Workspace:
//   const host = ctx.exports.WorkspaceServiceProxy({
//     props: { binding: "ContainerExample", id: ctx.id.toString() },
//   });
//   env.LOADER.get(`shell:${ctx.id}`, () => ({
//     env: { HOST: host },
//     ...
//   }));
//
//   // Inside the Dynamic Worker:
//   const ws = await env.HOST.getWorkspace();
//
// The proxy resolves env[binding] at call time — the same lazy
// lookup WorkspaceProxy does for the /ws upgrade path — so the
// DO class doesn't need to live in @cloudflare/computer. Any
// DO that exposes a `__getWorkspaceStub(): WorkspaceStub` RPC method
// works.
export interface WorkspaceServiceProxyProps {
  // Name of a DurableObjectNamespace binding in env. The proxy
  // resolves env[binding] at request time.
  binding: string;
  // Stringified DurableObjectId — typically ctx.id.toString()
  // from inside the owning DO's constructor.
  id: string;
}

export class WorkspaceServiceProxy extends WorkerEntrypoint<unknown, WorkspaceServiceProxyProps> {
  // Forward to the host DO's Workspace stub accessor. The method
  // name is intentionally private-looking so user code reaches for
  // `getWorkspace(stub)` instead of calling it directly.
  async getWorkspace(): Promise<unknown> {
    const stub = this.#hostStub<{ __getWorkspaceStub(): Promise<unknown> }>();
    return stub.__getWorkspaceStub();
  }

  // Optional Artifacts CLI hook used by the worker-backend shell.
  // Returning a target mirrors getWorkspace(): the dynamic Worker
  // captures the returned capability once and the command talks to
  // that target, instead of binding a method directly off HOST.
  async getArtifacts(): Promise<ArtifactsCLITarget> {
    const stub = this.#hostStub<{
      getArtifacts?: () => Promise<ArtifactsCLITarget>;
      artifactsCLI?: (input: ArtifactsCLIInput) => Promise<ArtifactsCLIResult>;
    }>();
    if (typeof stub.getArtifacts === "function") return stub.getArtifacts();
    if (typeof stub.artifactsCLI === "function") {
      return new ArtifactsCLITarget(
        (input) => stub.artifactsCLI?.(input) as Promise<ArtifactsCLIResult>,
      );
    }
    return new ArtifactsCLITarget(async () => ({
      stdout: "",
      stderr: "artifacts: host does not expose an Artifacts CLI\n",
      exitCode: 1,
    }));
  }

  // Back-compat direct hook. New shell code calls getArtifacts()
  // and captures the returned target instead.
  async artifactsCLI(input: ArtifactsCLIInput): Promise<ArtifactsCLIResult> {
    return (await this.getArtifacts()).cli(input);
  }

  #hostStub<T extends object>(): Rpc.DurableObjectBranded & T {
    const { binding, id } = this.ctx.props;
    const ns = (this.env as Record<string, unknown>)[binding] as
      | DurableObjectNamespace<Rpc.DurableObjectBranded & T>
      | undefined;
    if (!ns) {
      throw new Error(`WorkspaceServiceProxy: env.${binding} is not a DurableObjectNamespace`);
    }
    return ns.get(ns.idFromString(id)) as unknown as Rpc.DurableObjectBranded & T;
  }
}
