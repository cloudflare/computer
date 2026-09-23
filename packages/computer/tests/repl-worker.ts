// Test host for durable REPL sessions — the core eval loop.
//
// The DO is the session host by necessity: a plain worker cannot hold
// loader entrypoint stubs across per-request I/O contexts. `restart()`
// simulates a Durable Object eviction by rebuilding the Workspace over the
// same storage — exactly what a real restart does.

import { DurableObject } from "cloudflare:workers";
import type {
  DurableObjectStorageLike,
  ReplEvalOptions,
  ReplExecutionResult,
} from "../src/index.js";
import { Workspace } from "../src/index.js";

export interface Env {
  HOST: DurableObjectNamespace<ReplHostDO>;
  LOADER: WorkerLoader;
}

export class ReplHostDO extends DurableObject<Env> {
  #workspace: Workspace | undefined;

  #ws(): Workspace {
    this.#workspace ??= new Workspace({
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    });
    return this.#workspace;
  }

  async replEval(
    session: string,
    code: string,
    options?: ReplEvalOptions,
  ): Promise<ReplExecutionResult> {
    return this.#ws().repl(session, { loader: this.env.LOADER }).eval(code, options);
  }

  // Simulate DO eviction: drop every in-memory object. Storage survives.
  restart(): void {
    this.#workspace = undefined;
  }

  // Fire two evals concurrently inside the DO (bypasses input-gate
  // serialization of separate RPC calls) to exercise the session's
  // internal eval queue.
  async replEvalPair(
    session: string,
    codeA: string,
    codeB: string,
  ): Promise<[ReplExecutionResult, ReplExecutionResult]> {
    const repl = this.#ws().repl(session, { loader: this.env.LOADER });
    const [a, b] = await Promise.all([repl.eval(codeA), repl.eval(codeB)]);
    return [a, b];
  }

  // Corrupt the durable log out from under the session (divergence tests).
  corruptEffectKinds(session: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE repl_effects SET kind = 'corrupted' WHERE session = ?",
      session,
    );
  }

  injectExtraEffect(session: string, cellSeq: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO repl_effects (session, cell_seq, call_seq, kind, value)
       VALUES (?, ?, 999, 'random', '{"v":0.5}')`,
      session,
      cellSeq,
    );
  }
}

export default {
  fetch(): Response {
    return new Response("repl test host", { status: 200 });
  },
};
