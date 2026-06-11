// IWorkspaceContainerAPI — the seam CloudflareContainerBackend
// drives instead of talking to a Container binding directly. Two
// reasons it exists:
//
//   1. Same-DO vs cross-DO. A container-pool deployment wants the
//      DO that owns the Workspace (e.g. an Agent DO) to be separate
//      from the DO that owns the Container binding (a pool member
//      that can be re-leased between sessions). The pool member's
//      ctx.container isn't reachable from the Agent's isolate, but
//      an RpcTarget stub satisfying IWorkspaceContainerAPI is.
//
//   2. Testability. The interface is narrower than `Container` —
//      three methods — and fakes don't need to mimic the full
//      runtime surface.
//
// Consumers don't implement this interface directly. They mix
// `withWorkspaceContainer(Base)` into their DO class, which adds a
// single `ws` accessor returning a `WorkspaceContainerAPI` —
// an RpcTarget so it works the same in-isolate and across RPC.

import { RpcTarget } from "cloudflare:workers";

// Identifies the Durable Object that owns the Workspace and answers
// the /ws upgrade. Plain data so it can travel over Workers RPC.
export interface WorkspaceRef {
  // Binding name in the host Worker's env that resolves to the
  // DurableObjectNamespace for the Workspace-owning DO class.
  binding: string;
  // Stringified DurableObjectId of the specific Workspace owner.
  id: string;
}

// Driver surface CloudflareContainerBackend talks to. Implemented
// by WorkspaceContainerAPI below; exposed on consumer DOs through
// the `ws` accessor that withWorkspaceContainer installs.
export interface IWorkspaceContainerAPI {
  // Idempotent start. Returns once the runtime has accepted the
  // start command; readiness is verified by the backend polling
  // /health via port().
  start(env: Record<string, string>): Promise<void>;

  // Wire `host` → workspace inside the container's egress table.
  // Called once per backend connect(). The implementation
  // constructs the loopback Fetcher locally from {binding, id},
  // because Fetchers can't survive a Workers RPC hop.
  interceptOutboundHttp(host: string, workspace: WorkspaceRef): Promise<void>;

  // Fetch against a named TCP port inside the container. The fetch
  // runs in the container-owning Durable Object, so callers across
  // Workers RPC do not need to receive and reuse a Fetcher stub.
  fetchPort(port: number, input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

  // Return a Fetcher bound to the named TCP port inside the
  // container for same-isolate callers and advanced integrations.
  port(port: number): Fetcher;
}

// Concrete implementation. Extends RpcTarget so it travels intact
// across a Workers RPC boundary; in-isolate callers see plain
// method calls. Constructed by withWorkspaceContainer's `ws`
// getter — consumers don't instantiate this directly.
export class WorkspaceContainerAPI extends RpcTarget implements IWorkspaceContainerAPI {
  readonly #container: NonNullable<DurableObjectState["container"]>;
  readonly #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    super();
    if (!ctx.container) {
      throw new Error("WorkspaceContainerAPI: DO is not container-enabled (check wrangler.jsonc)");
    }
    this.#container = ctx.container;
    this.#ctx = ctx;
  }

  async start(env: Record<string, string>) {
    if (this.#container.running) return;
    this.#container.start({ enableInternet: true, env });
  }

  async interceptOutboundHttp(host: string, ref: WorkspaceRef) {
    // ctx.exports.WorkspaceProxy is bound by name in the
    // consumer's Worker (they re-export WorkspaceProxy from this
    // package). The cast keeps us independent of the consumer's
    // worker-configuration.d.ts.
    // ctx.exports is present at runtime but not on the public
    // DurableObjectState type; cast through unknown to reach it.
    const exports = (this.#ctx as unknown as { exports: Record<string, unknown> }).exports as {
      WorkspaceProxy: (opts: { props: WorkspaceRef }) => Fetcher;
    };
    await this.#container.interceptOutboundHttp(host, exports.WorkspaceProxy({ props: ref }));
  }

  fetchPort(port: number, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.#container.getTcpPort(port).fetch(input, init);
  }

  port(port: number) {
    return this.#container.getTcpPort(port);
  }
}

// TS requires a mixin class's constructor to take a single rest
// parameter, so we widen here. DurableObject's runtime signature
// is still (ctx, env); the rest tuple just makes TS happy. We
// don't constrain the instance shape because DurableObject's
// `ctx` is protected — visible inside the mixin's class body via
// `extends Base`, but not as a public structural property.
// biome-ignore lint/suspicious/noExplicitAny: mixin constructor shape requires any[]
type DOCtor = new (...args: any[]) => object;

// Mixin: add a single `getWorkspaceContainer()` method to a DO
// class. Returns a fresh WorkspaceContainerAPI bound to this DO's
// ctx. One name added to the consumer's class — nothing to
// forward to super, nothing else to override. A method (not a
// getter) so it crosses Workers RPC as a callable, and the
// long-form name keeps it from colliding with anything the
// consumer's base class might already expose.
//
// Same-DO usage (Agent owns the container):
//
//   export class Agent extends withWorkspaceContainer(
//     class extends DurableObject<Env> {},
//   ) {
//     #backend = new CloudflareContainerBackend({
//       container: () => this,
//       workspace: { binding: "Agent", id: this.ctx.id.toString() },
//     });
//   }
//
// Cross-DO usage (pool member owns the container):
//
//   export class WsdHost extends withWorkspaceContainer(
//     class extends DurableObject<Env> {},
//   ) {}
//
//   #backend = new CloudflareContainerBackend({
//     container: () => this.env.WsdHost.get(memberId),
//     workspace: { binding: "Agent", id: this.ctx.id.toString() },
//   });
//
// Constructor type the mixin returns. Written explicitly so
// rolldown-plugin-dts can emit a stable .d.ts (anonymous returned
// classes with method declarations trip its TS transformer).
export type WithWorkspaceContainerCtor<TBase extends DOCtor> = TBase &
  (new (
    // biome-ignore lint/suspicious/noExplicitAny: mirror mixin constructor shape
    ...args: any[]
  ) => InstanceType<TBase> & { getWorkspaceContainer(): WorkspaceContainerAPI });

export function withWorkspaceContainer<TBase extends DOCtor>(
  Base: TBase,
): WithWorkspaceContainerCtor<TBase> {
  class WithWorkspaceContainer extends Base {
    getWorkspaceContainer(): WorkspaceContainerAPI {
      return new WorkspaceContainerAPI((this as unknown as { ctx: DurableObjectState }).ctx);
    }
  }
  return WithWorkspaceContainer as WithWorkspaceContainerCtor<TBase>;
}
