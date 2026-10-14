import { Database } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it, vi } from "vitest";

import {
  callKey,
  createDurableTables,
  decodeValue,
  describeCall,
  encodeValue,
  ExecutionJournal,
} from "./journal.js";

function database() {
  const db = new Database(new SQLiteTestStorage());
  createDurableTables(db);
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
    expect(replay.begin("fs.readFile", ["/c"])).toEqual({ kind: "live", seq: 3 });
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
    expect(first.begin("host/ws:test.slow", [])).toEqual({ kind: "live", seq: 1 });
    const replay = new ExecutionJournal(db, "js", "run");
    expect(replay.begin("host/ws:test.slow", [])).toEqual({ kind: "live", seq: 1 });
    expect(replay.expectedCall()).toBeUndefined();
  });
});
