import { Database } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it, vi } from "vitest";

import {
  callKey,
  createResumeTables,
  decodeValue,
  describeCall,
  encodeValue,
  ExecutionJournal,
} from "./journal.js";

function database() {
  const db = new Database(new SQLiteTestStorage());
  createResumeTables(db);
  return db;
}

describe("callKey", () => {
  it("ignores object key order", () => {
    expect(callKey("fs.writeFile", [{ a: 1, b: 2 }])).toBe(
      callKey("fs.writeFile", [{ b: 2, a: 1 }]),
    );
  });

  it("tells calls apart by name, value and type", () => {
    const key = callKey("fs.writeFile", ["/a", "x"]);
    expect(callKey("fs.readFile", ["/a", "x"])).not.toBe(key);
    expect(callKey("fs.writeFile", ["/a", "y"])).not.toBe(key);
    expect(callKey("fs.writeFile", ["/a", new TextEncoder().encode("x")])).not.toBe(key);
  });
});

describe("describeCall", () => {
  it("shows arguments, summarizing bytes and cutting long values", () => {
    expect(describeCall("fs.writeFile", ["/a", new Uint8Array(3), "x".repeat(100)])).toBe(
      `fs.writeFile("/a", <3 bytes>, "${"x".repeat(46)}…)`,
    );
  });
});

describe("encodeValue", () => {
  it("round-trips byte arrays inside responses", () => {
    const value = { result: { data: new Uint8Array([0, 1, 255]), text: "t" } };
    expect(decodeValue(encodeValue(value))).toEqual(value);
  });
});

describe("ExecutionJournal", () => {
  function record(db: Database) {
    const journal = new ExecutionJournal(db, "js", "run");
    for (const path of ["/a", "/b"]) {
      const step = journal.begin("fs.readFile", [path]);
      if (step.kind !== "live") throw new Error("expected a live call");
      journal.commit(step.seq, { result: `contents of ${path}` });
    }
  }

  it("answers recorded calls in any order, then goes live", () => {
    const db = database();
    record(db);
    const replay = new ExecutionJournal(db, "js", "run");
    expect(replay.begin("fs.readFile", ["/b"])).toMatchObject({
      kind: "replay",
      response: { result: "contents of /b" },
    });
    expect(replay.expectedCall()).toBe('fs.readFile("/a")');
    expect(replay.begin("fs.readFile", ["/a"])).toMatchObject({
      kind: "replay",
      response: { result: "contents of /a" },
    });
    expect(replay.expectedCall()).toBeUndefined();
    expect(replay.begin("fs.readFile", ["/c"])).toEqual({ kind: "live", seq: 3, rerun: false });
  });

  it("reports a call the journal doesn't hold while recorded calls remain", () => {
    const db = database();
    record(db);
    const onDiverge = vi.fn<(message: string) => void>();
    const replay = new ExecutionJournal(db, "js", "run", onDiverge);
    const step = replay.begin("fs.rm", ["/a"]);
    expect(step).toMatchObject({ kind: "diverge" });
    expect(step.kind === "diverge" && step.message).toContain(
      'it called fs.rm("/a"), but the next call it made before was fs.readFile("/a").',
    );
    replay.diverged("diverged");
    expect(onDiverge).toHaveBeenCalledWith("diverged");
  });

  it("runs a call again when it was in flight at the interruption", () => {
    const db = database();
    const first = new ExecutionJournal(db, "js", "run");
    expect(first.begin("host/ws:test.slow", [])).toEqual({ kind: "live", seq: 1, rerun: false });
    const replay = new ExecutionJournal(db, "js", "run");
    expect(replay.begin("host/ws:test.slow", [])).toEqual({ kind: "live", seq: 1, rerun: true });
    expect(replay.expectedCall()).toBeUndefined();
  });

  it("numbers responses in the order they were committed", () => {
    const db = database();
    const first = new ExecutionJournal(db, "js", "run");
    const a = first.begin("fs.readFile", ["/a"]);
    const b = first.begin("fs.readFile", ["/b"]);
    if (a.kind !== "live" || b.kind !== "live") throw new Error("expected live calls");
    expect(first.commit(b.seq, { result: "b" })).toMatchObject({ ordinal: 1 });
    expect(first.commit(a.seq, { result: "a" })).toMatchObject({ ordinal: 2 });
    const replay = new ExecutionJournal(db, "js", "run");
    expect(replay.begin("fs.readFile", ["/a"])).toMatchObject({ kind: "replay", ordinal: 2 });
    expect(replay.begin("fs.readFile", ["/b"])).toMatchObject({ kind: "replay", ordinal: 1 });
    // Live responses after the replay carry on the numbering.
    const c = replay.begin("fs.readFile", ["/c"]);
    if (c.kind !== "live") throw new Error("expected a live call");
    expect(replay.commit(c.seq, { result: "c" })).toMatchObject({ ordinal: 3 });
  });

  it("splits a large response across rows", () => {
    const db = database();
    const first = new ExecutionJournal(db, "js", "run");
    const step = first.begin("net.fetch", [{ url: "https://example.test/big" }]);
    if (step.kind !== "live") throw new Error("expected a live call");
    const body = new Uint8Array(600 * 1024).map((_, index) => index % 251);
    first.commit(step.seq, { result: { status: 200, body } });
    expect(
      db.one<{ count: number }>("SELECT count(*) AS count FROM workspace_runtime_journal_chunks")
        ?.count,
    ).toBeGreaterThan(1);
    const replay = new ExecutionJournal(db, "js", "run");
    expect(replay.begin("net.fetch", [{ url: "https://example.test/big" }])).toMatchObject({
      kind: "replay",
      response: { result: { status: 200, body } },
    });
  });

  it("saves the event log in chunks that can arrive out of order", () => {
    const db = database();
    const first = new ExecutionJournal(db, "js", "run");
    first.record(2, [-1, 3]);
    first.record(0, [1, 2]);
    // Sent again by nobody, but harmless if it were.
    first.record(0, [1, 2]);
    expect(new ExecutionJournal(db, "js", "run").schedule()).toEqual([1, 2, -1, 3]);
  });

  it("drops log chunks past a gap", () => {
    const db = database();
    const first = new ExecutionJournal(db, "js", "run");
    first.record(0, [1]);
    first.record(3, [-2]);
    const replay = new ExecutionJournal(db, "js", "run");
    expect(replay.schedule()).toEqual([1]);
    // The replay logs those positions afresh, and the stale chunk is gone.
    replay.record(1, [2, 3]);
    replay.record(3, [-1]);
    expect(new ExecutionJournal(db, "js", "run").schedule()).toEqual([1, 2, 3, -1]);
  });

  it("refuses a malformed event log", () => {
    const journal = new ExecutionJournal(database(), "js", "run");
    for (const [position, events] of [
      [-1, [1]],
      [0, []],
      [0, [0]],
      [0, [1.5]],
      ["0", [1]],
    ] as const) {
      expect(() => journal.record(position, events)).toThrow("malformed event log");
    }
  });

  it("reports a replay that stops before a recorded call", () => {
    const db = database();
    record(db);
    const onDiverge = vi.fn<(message: string) => void>();
    const replay = new ExecutionJournal(db, "js", "run", onDiverge);
    replay.begin("fs.readFile", ["/a"]);
    replay.stalled();
    expect(onDiverge).toHaveBeenCalledWith(
      expect.stringContaining('it stopped before calling fs.readFile("/b").'),
    );
  });
});
