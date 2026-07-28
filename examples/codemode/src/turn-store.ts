/**
 * Durable state for agent turns that paused for human approval.
 *
 * A turn pauses in the middle of a model loop and resumes in a later
 * HTTP request, possibly minutes later, so everything needed to pick
 * it up again has to outlive the request that started it. That is the
 * whole reason this file exists: `runAgentTurn` is one `generateText`
 * call inside a fetch handler and has nowhere of its own to keep a
 * half-finished turn.
 *
 * The store is deliberately ignorant of the workspace. It holds
 * message history and approval decisions; it cannot run a command.
 * Keeping the component that records approvals separate from the
 * component that executes work is worth the extra file.
 *
 * `TurnStore` takes a storage handle rather than a durable object
 * state so the pause/resume bookkeeping can be tested against a plain
 * Map. The durable object in `session.ts` supplies the real one.
 */

import type { ModelMessage } from "ai";

import type { AgentToolCall, PendingApproval } from "./agent.js";

/**
 * The slice of `DurableObjectState["storage"]` this store needs. The
 * real handle satisfies it structurally.
 */
export interface TurnStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
}

/** A decision a human already took, kept for the audit trail. */
export interface ResolvedApproval {
  approvalId: string;
  approved: boolean;
  reason?: string;
  at: number;
}

export interface PausedTurn {
  turnId: string;
  status: "awaiting-approval" | "completed" | "rejected";
  /**
   * The turn's message history: the user prompt plus every assistant
   * and tool message the model loop has produced so far, including the
   * `tool-approval-request` parts. Replaying this with an approval
   * response attached is what resumes the turn, so it must stay
   * JSON-serializable.
   */
  messages: ModelMessage[];
  /** Approvals still waiting on a human. */
  pending: PendingApproval[];
  /**
   * Every approval id the current pause asked about, including the ones
   * already answered.
   *
   * A resume replays only this pass's decisions. Replaying an older
   * pass's approval would run its command a second time: the AI SDK
   * skips an already-satisfied approval only when the matching tool
   * result sits in the *last* message, and an earlier pass's result is
   * further back than that.
   */
  awaiting: string[];
  resolved: ResolvedApproval[];
  /** Every command the turn has run, across all of its passes. */
  toolCalls: AgentToolCall[];
  /**
   * Model steps the turn has spent. Carried across passes because the
   * AI SDK's step budget counts per `generateText` call, so a resumed
   * turn would otherwise be handed a fresh allowance every time.
   */
  stepsUsed: number;
  createdAt: number;
  updatedAt: number;
}

/** A queue entry: one pending approval, with its turn for context. */
export interface PendingApprovalView extends PendingApproval {
  turnId: string;
  requestedAt: number;
}

export interface TurnStoreOptions {
  /** Discard a turn nobody answered after this long. */
  maxAgeMs?: number;
  /** Keep at most this many turns. */
  maxTurns?: number;
}

const TURN_PREFIX = "turn:";
const APPROVAL_PREFIX = "approval:";

/** A day, matching what an unanswered approval is plausibly worth. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TURNS = 50;

export class TurnStore {
  readonly #storage: TurnStorageLike;
  readonly #maxAgeMs: number;
  readonly #maxTurns: number;

  constructor(storage: TurnStorageLike, options: TurnStoreOptions = {}) {
    this.#storage = storage;
    this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.#maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  }

  /**
   * Write a turn and reindex its approvals. The index maps an approval
   * id to its turn so resolving one is a single lookup rather than a
   * scan, and dropping an id from the index is what makes a resolved
   * approval unresolvable a second time.
   */
  async save(turn: PausedTurn): Promise<void> {
    const previous = await this.load(turn.turnId);
    if (previous != null) {
      for (const approval of previous.pending) {
        await this.#storage.delete(`${APPROVAL_PREFIX}${approval.approvalId}`);
      }
    }

    await this.#storage.put(`${TURN_PREFIX}${turn.turnId}`, turn);
    for (const approval of turn.pending) {
      await this.#storage.put(`${APPROVAL_PREFIX}${approval.approvalId}`, turn.turnId);
    }
  }

  async load(turnId: string): Promise<PausedTurn | null> {
    return (await this.#storage.get<PausedTurn>(`${TURN_PREFIX}${turnId}`)) ?? null;
  }

  /** Every approval waiting on a human, across all paused turns. */
  async pending(): Promise<PendingApprovalView[]> {
    const turns = await this.#storage.list<PausedTurn>({ prefix: TURN_PREFIX });
    const queue: PendingApprovalView[] = [];
    for (const turn of turns.values()) {
      if (turn.status !== "awaiting-approval") continue;
      for (const approval of turn.pending) {
        queue.push({ ...approval, turnId: turn.turnId, requestedAt: turn.updatedAt });
      }
    }
    return queue;
  }

  /**
   * Record one human decision.
   *
   * Returns null when the approval is not outstanding — an id that was
   * never issued, or one that has already been decided. Approval
   * queues are racy, and a second decision arriving from another tab
   * must not run the command a second time, so a no-op is reported as
   * a no-op rather than treated as a fresh approval.
   *
   * `ready` says whether the turn can resume: a single model step can
   * request several approvals, and the AI SDK wants every response in
   * one message, so a turn waits until the last of them is answered.
   */
  async resolve(
    approvalId: string,
    approved: boolean,
    reason?: string,
    now: number = Date.now(),
  ): Promise<{ turn: PausedTurn; ready: boolean; answers: ResolvedApproval[] } | null> {
    const turnId = await this.#storage.get<string>(`${APPROVAL_PREFIX}${approvalId}`);
    if (turnId == null) return null;

    const turn = await this.load(turnId);
    if (turn == null) return null;
    if (turn.status !== "awaiting-approval") return null;
    if (!turn.pending.some((approval) => approval.approvalId === approvalId)) return null;

    const updated: PausedTurn = {
      ...turn,
      pending: turn.pending.filter((approval) => approval.approvalId !== approvalId),
      resolved: [
        ...turn.resolved,
        { approvalId, approved, ...(reason != null ? { reason } : {}), at: now },
      ],
      updatedAt: now,
    };

    await this.#storage.put(`${TURN_PREFIX}${turnId}`, updated);
    await this.#storage.delete(`${APPROVAL_PREFIX}${approvalId}`);

    return {
      turn: updated,
      ready: updated.pending.length === 0,
      answers: updated.resolved.filter((entry) => updated.awaiting.includes(entry.approvalId)),
    };
  }

  /**
   * Drop turns that are too old or too numerous, along with their
   * approval index entries. A turn nobody ever answers would otherwise
   * sit in storage forever.
   */
  async prune(now: number = Date.now()): Promise<void> {
    const turns = [...(await this.#storage.list<PausedTurn>({ prefix: TURN_PREFIX })).values()];

    const stale = turns.filter((turn) => now - turn.updatedAt > this.#maxAgeMs);
    const survivors = turns
      .filter((turn) => now - turn.updatedAt <= this.#maxAgeMs)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const surplus = survivors.slice(this.#maxTurns);

    for (const turn of [...stale, ...surplus]) {
      await this.#forget(turn);
    }
  }

  async #forget(turn: PausedTurn): Promise<void> {
    for (const approval of turn.pending) {
      await this.#storage.delete(`${APPROVAL_PREFIX}${approval.approvalId}`);
    }
    await this.#storage.delete(`${TURN_PREFIX}${turn.turnId}`);
  }
}
