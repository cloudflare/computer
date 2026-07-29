// withWorkspace mixin.
//
// A durable object class extends `withWorkspace(Base, options)` to
// own a Workspace without hand-writing any wiring. The mixin:
//
//   - constructs the Workspace from the options the callback returns
//     (the callback receives the instance, so it can read `ctx` /
//     `env` after `super(...)` has run);
//   - stashes the Workspace on the instance under a module-private
//     symbol, so it's reachable by `getWorkspace(this)` in-isolate
//     but invisible to same-isolate property pokes and to Workers
//     RPC (symbol-keyed instance properties don't cross the wire);
//   - declares `__getWorkspaceStub()` in the class body so it lands
//     on the prototype, which is the only method shape Workers RPC
//     dispatches to. That's the door `getWorkspace(stub)` uses from a
//     Worker.
//
//   export class MyDO extends withWorkspace(
//     class extends DurableObject<Env> {},
//     (self) => ({
//       storage: self.ctx.storage,
//       sessionId: self.ctx.id.toString(),
//       backends: [/* ... */],
//     }),
//   ) {}
//
// Reach the Workspace through `getWorkspace` (see client.ts), the
// same way from inside the durable object (`getWorkspace(this)`) and
// from a Worker (`getWorkspace(env.MyDO.get(id))`).

import { Workspace, type WorkspaceOptions } from "./workspace.js";

// Module-private stash key. Never user-facing; never serialized.
export const WORKSPACE = Symbol("workspace");

// The prototype method `getWorkspace(stub)` calls over RPC. Exported
// so the client and its tests can name the shape.
export interface WorkspaceStubHost {
  __getWorkspaceStub(): Promise<import("./stub.js").WorkspaceStub>;
}

// A host that carries the symbol-stashed Workspace. Used by the
// local `getWorkspace(this)` path.
export interface WorkspaceLocalHost {
  [WORKSPACE]: Workspace;
}

// biome-ignore lint/suspicious/noExplicitAny: mixin constructor shape requires any[]
type DOCtor = new (...args: any[]) => object;

// Constructor type the mixin returns. Written out so
// rolldown-plugin-dts can emit a stable declaration.
export type WithWorkspaceCtor<TBase extends DOCtor> = TBase &
  (new (
    // biome-ignore lint/suspicious/noExplicitAny: mirror mixin constructor shape
    ...args: any[]
  ) => InstanceType<TBase> & WorkspaceStubHost & WorkspaceLocalHost);

export function withWorkspace<TBase extends DOCtor>(
  Base: TBase,
  options: (self: InstanceType<TBase>) => WorkspaceOptions,
): WithWorkspaceCtor<TBase> {
  class WithWorkspace extends Base {
    // biome-ignore lint/suspicious/noExplicitAny: mixin constructor shape requires any[]
    constructor(...args: any[]) {
      super(...args);
      const self = this as unknown as InstanceType<TBase>;
      (this as unknown as WorkspaceLocalHost)[WORKSPACE] = new Workspace(options(self));
    }

    __getWorkspaceStub(): Promise<import("./stub.js").WorkspaceStub> {
      const ws = (this as unknown as WorkspaceLocalHost)[WORKSPACE];
      return (async () => {
        await ws.ready();
        return ws.stub();
      })();
    }
  }
  return WithWorkspace as WithWorkspaceCtor<TBase>;
}
