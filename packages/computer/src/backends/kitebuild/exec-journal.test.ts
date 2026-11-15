import { Database, initializeSchema } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { ExecJournal } from "./exec-journal";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

function database(): Database {
  const db = new Database(new SQLiteTestStorage());
  initializeSchema(db, Date.now);
  return db;
}

describe("ExecJournal", () => {
  it("replays a finished execution's events in order", () => {
    const journal = new ExecJournal(database(), "kitebuild");
    journal.start("a");
    journal.append({ id: "a", seq: 1, name: "stdout", value: bytes("out") });
    journal.append({ id: "a", seq: 2, name: "stderr", value: bytes("err") });
    journal.append({ id: "a", seq: 3, name: "exit", code: 2 });
    expect(journal.load("a")).toBeUndefined();
    journal.finish("a", 2);
    const events = journal.load("a") ?? [];
    expect(events.map((event) => (event.name === "exit" ? event.code : text(event.value)))).toEqual(
      ["out", "err", 2],
    );
  });

  it("keeps executions per backend", () => {
    const db = database();
    const one = new ExecJournal(db, "one");
    one.start("a");
    one.finish("a", 0);
    expect(new ExecJournal(db, "two").load("a")).toBeUndefined();
    expect(one.load("a")).toEqual([]);
  });

  it("keeps output up to exactly maxBytes, says so, and returns what it kept", () => {
    const journal = new ExecJournal(database(), "kitebuild", { maxBytes: 4 });
    journal.start("a");
    const kept = [
      journal.append({ id: "a", seq: 1, name: "stdout", value: bytes("abc") }),
      journal.append({ id: "a", seq: 2, name: "stdout", value: bytes("defg") }),
      journal.append({ id: "a", seq: 4, name: "stdout", value: bytes("hij") }),
      journal.append({ id: "a", seq: 5, name: "exit", code: 0 }),
    ];
    journal.finish("a", 0);
    const events = journal.load("a") ?? [];
    expect(events.map((event) => [event.seq, event.name])).toEqual([
      [1, "stdout"],
      [2, "stdout"],
      [3, "stderr"],
      [5, "exit"],
    ]);
    expect(events[1].name === "stdout" && text(events[1].value)).toBe("d");
    expect(events[2].name === "stderr" && text(events[2].value)).toBe(
      "kitebuild: output past 4 bytes was dropped\n",
    );
    expect(kept).toEqual([[events[0]], [events[1], events[2]], [], [events[3]]]);
  });

  it("drops output after an exact fill without cutting it", () => {
    const journal = new ExecJournal(database(), "kitebuild", { maxBytes: 4 });
    journal.start("a");
    journal.append({ id: "a", seq: 1, name: "stdout", value: bytes("abcd") });
    journal.append({ id: "a", seq: 2, name: "stdout", value: bytes("e") });
    journal.append({ id: "a", seq: 3, name: "exit", code: 0 });
    journal.finish("a", 0);
    expect((journal.load("a") ?? []).map((event) => [event.seq, event.name])).toEqual([
      [1, "stdout"],
      [2, "stderr"],
      [3, "exit"],
    ]);
  });

  it("keeps a note past maxBytes", () => {
    const journal = new ExecJournal(database(), "kitebuild", { maxBytes: 4 });
    journal.start("a");
    journal.append({ id: "a", seq: 1, name: "stdout", value: bytes("abcdef") });
    const note = { id: "a", seq: 3, name: "stderr" as const, value: bytes("saving failed\n") };
    expect(journal.appendNote(note)).toEqual([note]);
    journal.append({ id: "a", seq: 4, name: "exit", code: 1 });
    journal.finish("a", 1);
    const events = journal.load("a") ?? [];
    expect(events.map((event) => [event.seq, event.name])).toEqual([
      [1, "stdout"],
      [2, "stderr"],
      [3, "stderr"],
      [4, "exit"],
    ]);
    expect(events[2].name === "stderr" && text(events[2].value)).toBe("saving failed\n");
  });

  it("cuts output at maxBytes back to the start of a UTF-8 character", () => {
    const journal = new ExecJournal(database(), "kitebuild", { maxBytes: 4 });
    journal.start("a");
    // The euro sign is three bytes, of which only two would fit.
    journal.append({ id: "a", seq: 1, name: "stdout", value: bytes("ab€") });
    journal.append({ id: "a", seq: 3, name: "exit", code: 0 });
    journal.finish("a", 0);
    const events = journal.load("a") ?? [];
    expect(events.map((event) => [event.seq, event.name])).toEqual([
      [1, "stdout"],
      [2, "stderr"],
      [3, "exit"],
    ]);
    expect(events[0].name === "stdout" && text(events[0].value)).toBe("ab");
  });

  it("adds the time columns to a table created without them", () => {
    const db = database();
    db.run(`
      CREATE TABLE workspace_runtime_executions (
        backend TEXT NOT NULL,
        id TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (backend, id)
      )
    `);
    const journal = new ExecJournal(db, "kitebuild");
    journal.start("a");
    journal.append({ id: "a", seq: 1, name: "exit", code: 0 });
    journal.finish("a", 0);
    journal.prune();
    expect(journal.load("a")).toEqual([{ id: "a", seq: 1, name: "exit", code: 0 }]);
  });

  it("settles executions left running as failed when it opens", () => {
    const db = database();
    const before = new ExecJournal(db, "kitebuild");
    before.start("a");
    before.append({ id: "a", seq: 1, name: "stdout", value: bytes("partial") });
    const events = new ExecJournal(db, "kitebuild").load("a") ?? [];
    expect(events.at(-1)).toMatchObject({ name: "exit", code: 1, seq: 3 });
    expect(events[1].name === "stderr" && text(events[1].value)).toMatch(/restarted/);
  });

  it("drops the oldest finished executions past maxExecutions", () => {
    let now = 1_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const journal = new ExecJournal(database(), "kitebuild", { maxExecutions: 2 });
      for (const id of ["a", "b", "c"]) {
        now += 1;
        journal.start(id);
        journal.finish(id, 0);
      }
      journal.prune();
      expect(["a", "b", "c"].map((id) => journal.load(id) !== undefined)).toEqual([
        false,
        true,
        true,
      ]);
    } finally {
      Date.now = realNow;
    }
  });

  it("forgets a disposed execution but not a running one", () => {
    const journal = new ExecJournal(database(), "kitebuild");
    journal.start("done");
    journal.finish("done", 0);
    journal.start("running");
    journal.dispose("done");
    journal.dispose("running");
    expect(journal.load("done")).toBeUndefined();
    journal.finish("running", 0);
    expect(journal.load("running")).toEqual([]);
  });
});
