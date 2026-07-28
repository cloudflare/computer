/**
 * `AgentSession` — the durable home for agent turns that are waiting on
 * a human.
 *
 * This is a second durable object, deliberately separate from the one
 * that owns the workspace. The workspace durable object is a
 * filesystem with backends attached; it does not know an agent exists,
 * and adding a queue of half-finished model turns to it would change
 * that. So approval state gets its own object, addressed by the same
 * name, and the workspace stays a workspace.
 *
 * It is worth noticing what this object cannot do: it holds no
 * workspace stub and registers no backends, so it cannot run a
 * command. The component that records approval decisions and the
 * component that executes work are separate, which is a property worth
 * having in the part of the system whose whole job is saying no.
 *
 * The model loop itself still runs in the Worker, as it did before.
 * This object only remembers where a turn got to.
 */

import { DurableObject } from "cloudflare:workers";

import {
  type PausedTurn,
  type PendingApprovalView,
  type ResolvedApproval,
  type TurnStorageLike,
  TurnStore,
} from "./turn-store.js";

/**
 * The session's RPC surface, as callers see it.
 *
 * Callers reach the durable object through this interface rather than
 * through the stub's own inferred type. A `PausedTurn` carries
 * `ModelMessage[]`, and asking tsc to wrap that union in the stub's
 * recursive promise-pipelined types walks it past the
 * instantiation-depth limit (TS2589). Naming the surface up front
 * sidesteps that walk; the runtime shape is identical.
 */
export interface AgentSessionLike {
  saveTurn(turn: PausedTurn): Promise<void>;
  getTurn(turnId: string): Promise<PausedTurn | null>;
  pendingApprovals(): Promise<PendingApprovalView[]>;
  resolveApproval(
    approvalId: string,
    approved: boolean,
    reason?: string,
  ): Promise<{ turn: PausedTurn; ready: boolean; answers: ResolvedApproval[] } | null>;
}

export class AgentSession extends DurableObject<Env> {
  readonly #turns: TurnStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The durable object's storage declares wider overloads than the
    // four methods the store needs; the runtime shape matches.
    this.#turns = new TurnStore(ctx.storage as unknown as TurnStorageLike);
  }

  /**
   * Record where a turn got to. Pruning runs on the way out so an
   * approval nobody ever answers cannot accumulate forever.
   */
  async saveTurn(turn: PausedTurn): Promise<void> {
    await this.#turns.save(turn);
    await this.#turns.prune();
  }

  async getTurn(turnId: string): Promise<PausedTurn | null> {
    return this.#turns.load(turnId);
  }

  /** Everything waiting on a human, for whoever works the queue. */
  async pendingApprovals(): Promise<PendingApprovalView[]> {
    return this.#turns.pending();
  }

  /**
   * Record one decision. Null means the approval was not outstanding —
   * an unknown id, or one that someone already answered.
   */
  async resolveApproval(
    approvalId: string,
    approved: boolean,
    reason?: string,
  ): Promise<{ turn: PausedTurn; ready: boolean; answers: ResolvedApproval[] } | null> {
    return this.#turns.resolve(approvalId, approved, reason);
  }
}
