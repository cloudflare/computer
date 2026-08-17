// Makes `@cloudflare/computer`'s main entry importable under plain node.
//
// The entry re-exports WorkspaceProxy, which extends WorkerEntrypoint
// from `cloudflare:workers`. That specifier only resolves inside
// workerd, so a plain `import` of the entry fails with
// ERR_UNSUPPORTED_ESM_URL_SCHEME before any of the exports a host-side
// script actually wants become reachable.
//
// Registering a resolve hook for the specifier costs less than the
// alternatives. Importing dist files individually needs per-file build
// entries the bundler does not emit, and adding them would duplicate
// bundled code to suit a script.
//
// The stubs only have to satisfy `class X extends Y` at module
// evaluation time. Nothing here is ever constructed: a script that
// reaches for Workers runtime behavior wants workerd, not this.
//
// Use it with node's --import flag:
//
//   node --import ./script/lib/cloudflare-workers-stub.mjs script.mjs
import { registerHooks } from "node:module";

const SPECIFIER = "cloudflare:workers";
const STUB_URL = "cloudflare-workers-stub:main";

const SOURCE = `
export class RpcTarget {}

class Entrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint extends Entrypoint {}
export class DurableObject extends Entrypoint {}

export const tracing = {
  enterSpan(_name, callback) {
    return callback();
  },
};
`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === SPECIFIER) {
      return { url: STUB_URL, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === STUB_URL) {
      return { format: "module", source: SOURCE, shortCircuit: true };
    }
    return next(url, context);
  },
});
