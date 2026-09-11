import { describe, expect, it, vi } from "vitest";

import { createSyncLogger, syncBlockLog } from "./sync-telemetry.js";

// Spans are the right shape for tracing, but Workers Logs is what the
// telemetry query API can aggregate today: structured console.log output
// becomes filterable `$workers.event.*` fields, and percentiles over a
// numeric field need the field to exist in the log record.
//
// So the block emitter's contract is: one flat, single-line JSON record
// per committed block, with every field a caller would want to filter or
// aggregate on already at the top level. Nested objects and arrays would
// force a query to reach through indexed paths, which is fragile.

describe("syncBlockLog", () => {
  it("carries a stable event name so queries can select these records", () => {
    const record = syncBlockLog({
      backend: "container",
      direction: "pull",
      mode: "entries",
      operationId: "op-1",
      generation: "gen-1",
      entries: 12,
      bytes: 2048,
      skipped: 0,
      complete: false,
      blockMs: 210,
      cursorRev: 42,
      targetRev: 99,
    });

    expect(record.event).toBe("sync.block");
  });

  it("flattens every queryable value to the top level", () => {
    const record = syncBlockLog({
      backend: "container",
      direction: "pull",
      mode: "pack",
      operationId: "op-1",
      generation: "gen-1",
      entries: 2000,
      bytes: 1024,
      skipped: 3,
      complete: true,
      blockMs: 15812,
      cursorRev: 42,
      targetRev: 42,
    });

    // A telemetry filter addresses `$workers.event.<key>`, so nesting
    // would turn every query into an indexed path lookup.
    for (const value of Object.values(record)) {
      expect(typeof value).not.toBe("object");
    }
  });

  it("reports the CPU headroom a block left against its limit", () => {
    const record = syncBlockLog({
      backend: "container",
      direction: "pull",
      mode: "pack",
      operationId: "op-1",
      generation: "gen-1",
      entries: 2000,
      bytes: 1024,
      skipped: 0,
      complete: false,
      blockMs: 15000,
      cursorRev: 1,
      targetRev: 2,
      cpuLimitMs: 30_000,
    });

    // The single most important production question: how close did the
    // worst block come to the limit. Precomputing it means a query can
    // just take min() rather than dividing across two fields.
    expect(record.headroom).toBe(2);
  });

  it("omits headroom when the block took no measurable time", () => {
    const record = syncBlockLog({
      backend: "container",
      direction: "pull",
      mode: "entries",
      operationId: "op-1",
      generation: "gen-1",
      entries: 0,
      bytes: 0,
      skipped: 0,
      complete: true,
      blockMs: 0,
      cursorRev: 1,
      targetRev: 1,
    });

    expect(record.headroom).toBeUndefined();
  });

  it("derives per-entry cost so slow blocks are comparable across sizes", () => {
    const record = syncBlockLog({
      backend: "container",
      direction: "pull",
      mode: "entries",
      operationId: "op-1",
      generation: "gen-1",
      entries: 100,
      bytes: 0,
      skipped: 0,
      complete: false,
      blockMs: 250,
      cursorRev: 1,
      targetRev: 2,
    });

    expect(record.msPerEntry).toBe(2.5);
  });

  it("marks a block that exceeded its CPU budget", () => {
    const record = syncBlockLog({
      backend: "container",
      direction: "pull",
      mode: "pack",
      operationId: "op-1",
      generation: "gen-1",
      entries: 4000,
      bytes: 0,
      skipped: 0,
      complete: false,
      blockMs: 31_000,
      cursorRev: 1,
      targetRev: 2,
      cpuLimitMs: 30_000,
    });

    // A boolean is cheaper to filter on than a computed comparison, and
    // this is the condition that means the design is failing.
    expect(record.overBudget).toBe(true);
  });

  it("does not mark a block inside its budget", () => {
    const record = syncBlockLog({
      backend: "container",
      direction: "pull",
      mode: "pack",
      operationId: "op-1",
      generation: "gen-1",
      entries: 2000,
      bytes: 0,
      skipped: 0,
      complete: false,
      blockMs: 4_000,
      cursorRev: 1,
      targetRev: 2,
      cpuLimitMs: 30_000,
    });

    expect(record.overBudget).toBe(false);
  });

  it("reports how far behind the target a block left the cursor", () => {
    const record = syncBlockLog({
      backend: "container",
      direction: "pull",
      mode: "entries",
      operationId: "op-1",
      generation: "gen-1",
      entries: 500,
      bytes: 0,
      skipped: 0,
      complete: false,
      blockMs: 100,
      cursorRev: 40,
      targetRev: 99,
    });

    // Convergence lag. A sync that never closes this gap is the failure
    // an operator most wants an alert on.
    expect(record.revsBehind).toBe(59);
  });
});

describe("createSyncLogger", () => {
  it("emits one single-line JSON record per block", () => {
    const lines: string[] = [];
    const logger = createSyncLogger({ log: (line) => lines.push(line) });

    logger.block({
      backend: "container",
      direction: "pull",
      mode: "entries",
      operationId: "op-1",
      generation: "gen-1",
      entries: 10,
      bytes: 20,
      skipped: 0,
      complete: true,
      blockMs: 5,
      cursorRev: 2,
      targetRev: 2,
    });

    expect(lines).toHaveLength(1);
    // Workers Logs parses a single JSON argument into queryable fields;
    // multi-line output would be split across records.
    expect(lines[0]).not.toContain("\n");
    expect(JSON.parse(lines[0]).event).toBe("sync.block");
  });

  it("defaults to console.log so a Worker needs no wiring", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const logger = createSyncLogger();
      logger.block({
        backend: "container",
        direction: "push",
        mode: "pack",
        operationId: "op-1",
        generation: "gen-1",
        entries: 1,
        bytes: 1,
        skipped: 0,
        complete: true,
        blockMs: 1,
        cursorRev: 1,
        targetRev: 1,
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("is silent when disabled so the default costs nothing", () => {
    const lines: string[] = [];
    const logger = createSyncLogger({ enabled: false, log: (line) => lines.push(line) });

    logger.block({
      backend: "container",
      direction: "pull",
      mode: "entries",
      operationId: "op-1",
      generation: "gen-1",
      entries: 10,
      bytes: 20,
      skipped: 0,
      complete: true,
      blockMs: 5,
      cursorRev: 2,
      targetRev: 2,
    });

    expect(lines).toEqual([]);
  });

  it("emits an operation summary when a sync completes", () => {
    const lines: string[] = [];
    const logger = createSyncLogger({ log: (line) => lines.push(line) });

    logger.operation({
      backend: "container",
      direction: "pull",
      mode: "pack",
      operationId: "op-1",
      generation: "gen-1",
      blocks: 13,
      entries: 49_001,
      bytes: 3_597_900,
      skipped: 0,
      totalMs: 122_325,
      worstBlockMs: 15_812,
      restarts: 12,
    });

    const record = JSON.parse(lines[0]);
    expect(record.event).toBe("sync.operation");
    // The per-block records answer "did any block get close to the
    // limit"; this one answers "what did the whole sync cost", which is
    // the number the plan's 172-second claim is about.
    expect(record.blocks).toBe(13);
    expect(record.worstBlockMs).toBe(15_812);
  });

  it("derives effective throughput on the operation summary", () => {
    const lines: string[] = [];
    const logger = createSyncLogger({ log: (line) => lines.push(line) });

    logger.operation({
      backend: "container",
      direction: "pull",
      mode: "pack",
      operationId: "op-1",
      generation: "gen-1",
      blocks: 2,
      entries: 100,
      bytes: 2_000_000,
      skipped: 0,
      totalMs: 1_000,
      worstBlockMs: 600,
      restarts: 0,
    });

    // Bytes per second over the whole operation. This is the field that
    // finally answers the open question behind the pack thresholds:
    // what bandwidth does the real DO-to-container hop achieve.
    expect(JSON.parse(lines[0]).bytesPerSecond).toBe(2_000_000);
  });

  it("survives a logger that throws so telemetry cannot break a sync", () => {
    const logger = createSyncLogger({
      log: () => {
        throw new Error("log sink exploded");
      },
    });

    expect(() =>
      logger.block({
        backend: "container",
        direction: "pull",
        mode: "entries",
        operationId: "op-1",
        generation: "gen-1",
        entries: 1,
        bytes: 1,
        skipped: 0,
        complete: true,
        blockMs: 1,
        cursorRev: 1,
        targetRev: 1,
      }),
    ).not.toThrow();
  });
});
