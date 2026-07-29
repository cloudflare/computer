// Node-runner stub for cloudflare:workers.
//
// The worker backend's entrypoint.ts extends WorkerEntrypoint from
// cloudflare:workers. Vitest's node runner can't resolve that
// module; aliasing to this stub lets the test file import without
// blowing up. The stubs preserve the constructor signature so
// subclasses can `super(ctx, env)` without runtime errors; method
// bodies are tested through the subclass surfaces, not the base
// class itself.

export class WorkerEntrypoint {
  ctx: unknown;
  env: unknown;
  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject {
  ctx: unknown;
  env: unknown;
  constructor(ctx?: unknown, env?: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class RpcTarget {}
