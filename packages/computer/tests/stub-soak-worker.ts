// Workerd test harness for the WorkspaceStub soak.
//
// Two exports:
//
//   - ComputerdContainer (DO): owns a Workspace backed by an in-process
//     fake backend (no computerd, no network). Has two RPC methods:
//        getWorkspace()   — returns ws.stub() across the Workers
//                            RPC boundary. The caller's stub goes
//                            through capnweb-style disposal.
//        stubSnapshot()   — reads the per-class live counter from
//                            @cloudflare/computer-rpc/debug.
//
//   - TestDriver (default): a WorkerEntrypoint with a single
//     fetch() that runs the soak workload. Lets the test drive
//     the cross-boundary calls with one round trip per test case.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { ShellRPC, SyncRPC, WorkspaceRPC } from "@cloudflare/computer-rpc";
import { enableStubTracking, stubSnapshot } from "@cloudflare/computer-rpc/debug";
import type { ChangeEntry } from "@cloudflare/dofs";
import { Database, initializeSchema } from "@cloudflare/dofs";

import type { BackendHandle, WorkspaceBackend } from "../src/backend.js";
import type { WorkspaceStub } from "../src/stub.js";
import { Workspace } from "../src/workspace.js";

// Workerd doesn't expose wrangler `vars` on process.env or globalThis,
// so flip the tracker on at module load.
enableStubTracking();

export interface Env {
  COMPUTERD: DurableObjectNamespace<ComputerdContainer>;
}

// Fake backend so the Workspace doesn't try to dial computerd. Sync
// methods return empty/no-op; exec returns a single exit event so
// shell.exec resolves without a real subprocess.
function fakeBackend(): WorkspaceBackend {
  let appliedPushRev = 0;
  const sync: SyncRPC = {
    async push(input) {
      appliedPushRev = input.senderRev;
      return { rev: 0, appliedPushCursor: { rev: appliedPushRev, path: null } };
    },
    async fetchChanges() {
      return {
        currentCursor: { rev: 0, path: null },
        appliedPushCursor: { rev: appliedPushRev, path: null },
        stream: new ReadableStream<ChangeEntry>({
          start(c) {
            c.close();
          },
        }),
      };
    },
    async readEntry() {
      return null;
    },
    async watermarks() {
      return {
        currentRev: 0,
        pushRev: 0,
        fetchCursor: { rev: appliedPushRev, path: null },
      };
    },
    async hasObjects() {
      return [];
    },
    fetchObjects() {
      return new ReadableStream({
        start(c) {
          c.close();
        },
      });
    },
    async pushObjects() {},
  };
  let next = 0;
  const shell: ShellRPC = {
    async exec({ id }) {
      const useId = id ?? `e-${++next}`;
      return {
        id: useId,
        events: new ReadableStream({
          start(c) {
            c.enqueue({ id: useId, seq: 1, name: "exit", value: 0 });
            c.close();
          },
        }),
      };
    },
    async getExec({ id }) {
      return {
        id,
        events: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      };
    },
    async killExec() {},
    async disposeExec() {},
  };
  const rpc: WorkspaceRPC = { sync, shell };
  return {
    id: "fake",
    async connect(): Promise<BackendHandle> {
      return { rpc, close: async () => {} };
    },
  };
}

export class ComputerdContainer extends DurableObject<Env> {
  #ws: Workspace | undefined;

  async #ensure(): Promise<Workspace> {
    if (this.#ws) return this.#ws;
    // initializeSchema is idempotent; safe to call on every
    // construction. Workspace's constructor opens a Database
    // against ctx.storage so the schema must exist first.
    const db = new Database(this.ctx.storage);
    initializeSchema(db, () => Date.now());
    this.#ws = new Workspace({
      storage: this.ctx.storage,
      backends: [fakeBackend()],
    });
    await this.#ws.ready();
    return this.#ws;
  }

  async getWorkspace(): Promise<WorkspaceStub> {
    const ws = await this.#ensure();
    return ws.stub();
  }

  async stubSnapshot(): Promise<Record<string, number>> {
    return stubSnapshot();
  }
}

export default class TestDriver extends WorkerEntrypoint<Env> {
  // Direct RPC entrypoint the test calls via SELF
  // (vitest-pool-workers gives us the SELF binding).
  async runSoak(opts: {
    iterations: number;
    disposeStubs: boolean;
    disposeExecHandles: boolean;
  }): Promise<{
    baseline: Record<string, number>;
    afterIterations: Record<string, number>;
    afterClose: Record<string, number>;
    iterations: number;
  }> {
    const id = this.env.COMPUTERD.idFromName("soak");
    const stub = this.env.COMPUTERD.get(id);

    const baseline = await stub.stubSnapshot();

    for (let i = 0; i < opts.iterations; i++) {
      const ws = await stub.getWorkspace();
      // Touch fs + shell to ensure the sub-stubs get instantiated
      // on the DO side.
      await ws.fs.writeFile(`/soak-${i}.txt`, `hello ${i}`);
      await ws.fs.readFile(`/soak-${i}.txt`, "utf8");
      const handle = await ws.runtime.exec("noop");
      await handle.result();
      if (opts.disposeExecHandles) {
        (handle as unknown as Disposable)[Symbol.dispose]?.();
      }
      if (opts.disposeStubs) {
        (ws as unknown as Disposable)[Symbol.dispose]?.();
      }
    }

    // Sample on the DO side after the loop but before any GC tick.
    const afterIterations = await stub.stubSnapshot();

    // Give the runtime a beat to flush deferred disposers.
    await scheduler.wait(50);
    const afterClose = await stub.stubSnapshot();

    return {
      baseline,
      afterIterations,
      afterClose,
      iterations: opts.iterations,
    };
  }

  override async fetch(): Promise<Response> {
    return new Response("ok");
  }
}
