import { beforeEach, describe, expect, it } from "vitest";

import type { PendingApproval } from "./agent.js";
import { type PausedTurn, type TurnStorageLike, TurnStore } from "./turn-store.js";

/** The durable object's storage, reduced to a Map. */
class MemoryStorage implements TurnStorageLike {
  readonly entries = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.entries.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const prefix = options?.prefix ?? "";
    const found = new Map<string, T>();
    for (const [key, value] of this.entries) {
      if (key.startsWith(prefix)) found.set(key, structuredClone(value) as T);
    }
    return found;
  }
}

function approval(approvalId: string, command = "rm -rf /workspace"): PendingApproval {
  return {
    approvalId,
    toolCallId: `call-${approvalId}`,
    backend: "shell",
    command,
    cwd: null,
    reason: `"rm" is not a recognized read-only command`,
  };
}

function turn(overrides: Partial<PausedTurn> = {}): PausedTurn {
  const createdAt = overrides.createdAt ?? 1_000;
  const pending = overrides.pending ?? [approval("a1")];
  return {
    turnId: "turn-1",
    status: "awaiting-approval",
    messages: [{ role: "user", content: "delete the workspace" }],
    pending,
    awaiting: pending.map((entry) => entry.approvalId),
    resolved: [],
    toolCalls: [],
    stepsUsed: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe("TurnStore", () => {
  let storage: MemoryStorage;
  let store: TurnStore;

  beforeEach(() => {
    storage = new MemoryStorage();
    store = new TurnStore(storage);
  });

  describe("save and load", () => {
    it("round-trips a paused turn", async () => {
      const saved = turn();
      await store.save(saved);
      expect(await store.load("turn-1")).toEqual(saved);
    });

    it("returns null for a turn it never saw", async () => {
      expect(await store.load("nope")).toBeNull();
    });

    it("overwrites an earlier version of the same turn", async () => {
      await store.save(turn());
      await store.save(turn({ status: "completed", pending: [], stepsUsed: 4 }));
      const loaded = await store.load("turn-1");
      expect(loaded?.status).toBe("completed");
      expect(loaded?.stepsUsed).toBe(4);
      expect(loaded?.pending).toEqual([]);
    });
  });

  describe("pending", () => {
    it("is empty to start", async () => {
      expect(await store.pending()).toEqual([]);
    });

    it("flattens the queue across turns, tagging each with its turn", async () => {
      await store.save(turn({ turnId: "turn-1", pending: [approval("a1")], createdAt: 1_000 }));
      await store.save(
        turn({
          turnId: "turn-2",
          pending: [approval("a2"), approval("a3", "mkdir /workspace/d")],
          createdAt: 2_000,
        }),
      );

      const queue = await store.pending();
      expect(queue).toHaveLength(3);
      expect(queue.map((entry) => entry.approvalId).sort()).toEqual(["a1", "a2", "a3"]);
      expect(queue.find((entry) => entry.approvalId === "a1")?.turnId).toBe("turn-1");
      expect(queue.find((entry) => entry.approvalId === "a3")?.turnId).toBe("turn-2");
      expect(queue.find((entry) => entry.approvalId === "a3")?.command).toBe("mkdir /workspace/d");
      for (const entry of queue) {
        expect(entry.requestedAt).toBeGreaterThan(0);
        expect(entry.reason.length).toBeGreaterThan(0);
      }
    });

    it("leaves out turns that are no longer waiting", async () => {
      await store.save(turn({ turnId: "turn-1", status: "completed", pending: [] }));
      expect(await store.pending()).toEqual([]);
    });
  });

  describe("resolve", () => {
    it("records an approval and reports the turn ready to resume", async () => {
      await store.save(turn());
      const outcome = await store.resolve("a1", true);

      expect(outcome).not.toBeNull();
      expect(outcome?.ready).toBe(true);
      expect(outcome?.turn.pending).toEqual([]);
      expect(outcome?.turn.resolved).toHaveLength(1);
      expect(outcome?.turn.resolved[0]).toMatchObject({ approvalId: "a1", approved: true });
    });

    it("records a rejection with its reason", async () => {
      await store.save(turn());
      const outcome = await store.resolve("a1", false, "not now");

      expect(outcome?.ready).toBe(true);
      expect(outcome?.turn.resolved[0]).toMatchObject({
        approvalId: "a1",
        approved: false,
        reason: "not now",
      });
    });

    it("persists the resolution", async () => {
      await store.save(turn());
      await store.resolve("a1", true);
      const loaded = await store.load("turn-1");
      expect(loaded?.pending).toEqual([]);
      expect(loaded?.resolved).toHaveLength(1);
    });

    it("holds a turn back until every approval in the step is resolved", async () => {
      await store.save(turn({ pending: [approval("a1"), approval("a2")] }));

      const first = await store.resolve("a1", true);
      expect(first?.ready).toBe(false);
      expect(first?.turn.pending.map((entry) => entry.approvalId)).toEqual(["a2"]);

      const second = await store.resolve("a2", true);
      expect(second?.ready).toBe(true);
      expect(second?.turn.pending).toEqual([]);
      expect(second?.turn.resolved.map((entry) => entry.approvalId)).toEqual(["a1", "a2"]);
    });

    it("refuses a second decision on the same approval", async () => {
      // An approval UI is racy: two operators, two tabs, a double
      // click. Resolving twice must not run the command twice.
      await store.save(turn());
      expect(await store.resolve("a1", true)).not.toBeNull();
      expect(await store.resolve("a1", true)).toBeNull();
      expect(await store.resolve("a1", false)).toBeNull();
    });

    it("refuses an approval id it never issued", async () => {
      await store.save(turn());
      expect(await store.resolve("bogus", true)).toBeNull();
    });

    it("drops the approval from the queue once resolved", async () => {
      await store.save(turn({ pending: [approval("a1"), approval("a2")] }));
      await store.resolve("a1", true);
      expect((await store.pending()).map((entry) => entry.approvalId)).toEqual(["a2"]);
    });

    it("stamps when the decision was taken", async () => {
      await store.save(turn());
      const outcome = await store.resolve("a1", true);
      expect(outcome?.turn.resolved[0].at).toBeGreaterThan(0);
    });

    it("answers with this pause's decisions only", async () => {
      // A turn that pauses twice accumulates decisions. Replaying an
      // earlier pass's approval would run its command again, because
      // the AI SDK only recognizes an approval as already satisfied
      // when its tool result is in the last message.
      await store.save(
        turn({
          pending: [approval("a2")],
          awaiting: ["a2"],
          resolved: [{ approvalId: "a1", approved: true, at: 500 }],
        }),
      );

      const outcome = await store.resolve("a2", true);

      expect(outcome?.ready).toBe(true);
      expect(outcome?.answers.map((entry) => entry.approvalId)).toEqual(["a2"]);
      // The earlier decision stays on the record for the audit trail.
      expect(outcome?.turn.resolved.map((entry) => entry.approvalId)).toEqual(["a1", "a2"]);
    });

    it("answers with every decision from the current pause", async () => {
      await store.save(turn({ pending: [approval("a1"), approval("a2")] }));
      await store.resolve("a1", false, "no");
      const outcome = await store.resolve("a2", true);

      expect(outcome?.answers).toHaveLength(2);
      expect(outcome?.answers.map((entry) => entry.approved)).toEqual([false, true]);
    });
  });

  describe("prune", () => {
    it("drops a paused turn once it goes stale", async () => {
      const store = new TurnStore(storage, { maxAgeMs: 1_000 });
      await store.save(turn({ turnId: "fresh", createdAt: 10_000, updatedAt: 10_000 }));
      await store.save(turn({ turnId: "stale", createdAt: 1_000, updatedAt: 1_000 }));

      await store.prune(10_500);

      expect(await store.load("fresh")).not.toBeNull();
      expect(await store.load("stale")).toBeNull();
    });

    it("keeps a paused turn inside its age limit", async () => {
      const store = new TurnStore(storage, { maxAgeMs: 60_000 });
      await store.save(turn({ createdAt: 1_000, updatedAt: 1_000 }));
      await store.prune(30_000);
      expect(await store.load("turn-1")).not.toBeNull();
    });

    it("keeps only the newest turns when there are too many", async () => {
      const store = new TurnStore(storage, { maxTurns: 2 });
      for (const [id, at] of [
        ["oldest", 1_000],
        ["middle", 2_000],
        ["newest", 3_000],
      ] as Array<[string, number]>) {
        await store.save(turn({ turnId: id, createdAt: at, updatedAt: at }));
      }

      await store.prune(3_000);

      expect(await store.load("oldest")).toBeNull();
      expect(await store.load("middle")).not.toBeNull();
      expect(await store.load("newest")).not.toBeNull();
    });

    it("takes the pruned turn's approvals out of the queue with it", async () => {
      const store = new TurnStore(storage, { maxAgeMs: 1_000 });
      await store.save(turn({ turnId: "stale", createdAt: 1_000, updatedAt: 1_000 }));
      await store.prune(10_000);

      expect(await store.pending()).toEqual([]);
      expect(await store.resolve("a1", true)).toBeNull();
      // Nothing is left behind that a later scan would trip over.
      expect(storage.entries.size).toBe(0);
    });
  });
});
