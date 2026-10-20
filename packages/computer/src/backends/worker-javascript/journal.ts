// Durable execution state for the JavaScript backend.
//
// An execution started with `onInterrupt: "restart"` or `"replay"` saves
// what it needs to start again: its module graph, input, context and
// limits. A replayed execution also journals every capability call it
// makes, writing each response before the isolate sees it. After the
// object restarts, the execution runs again from the top and the bridge
// answers its calls from the journal instead of running them, until the
// journal runs out and the execution carries on live.
//
// Each response is numbered when it's committed. The isolate logs the
// order it saw its events in, each response by number and each timer by
// the order it was set, and sends the log along with its next call or
// output, so the log is saved before anything that depends on it. When
// the run replays, the isolate gets the log and sees its events in that
// order again. A call the journal doesn't hold, while journaled calls are
// still unanswered, means the code took a different path anyway, and the
// execution fails rather than continue on a state the journal can't
// vouch for.

import type { Database } from "@cloudflare/dofs";

import type { BridgeJournal, BridgeResponse } from "../../runtime/bridge.js";
import type { WorkspaceRuntimeValue } from "../../runtime/types.js";

export type InterruptPolicy = "fail" | "restart" | "replay";

export const INTERRUPT_POLICIES: readonly InterruptPolicy[] = ["fail", "restart", "replay"];

/** Bump when the saved start or journal format changes. */
export const JOURNAL_VERSION = 1;

/**
 * Bump when a change to the code the runtime loads into the isolate
 * would replay a run differently, so that runs started on the old code
 * fail instead of resuming wrongly. A test notices when that code
 * changes and asks for this check.
 */
export const REPLAY_VERSION = 1;

/**
 * How many attempts an execution gets, since it last journaled a call,
 * before an interruption fails it.
 */
export const MAX_INTERRUPT_ATTEMPTS = 3;

/**
 * How many interrupted runs restart at once. A Durable Object runs at
 * most ten Dynamic Workers at a time, and new executions need some.
 */
export const MAX_CONCURRENT_RECOVERIES = 4;

// Saved start data and large responses are split across rows, since a
// Durable Object's SQLite holds at most 2 MB in a row.
const CHUNK_CHARACTERS = 256 * 1024;

export interface DurableStart {
  readonly version: number;
  readonly modules: Record<string, string | { js?: string }>;
  readonly entryName: string;
  readonly input: WorkspaceRuntimeValue;
  readonly env: Record<string, string>;
  readonly cwd: string;
  /** Base64. */
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly cpuMs: number;
  readonly startedAt: number;
  /** 64 hex digits that seed the run's random numbers. */
  readonly seed: string;
  /** Identifies the runtime the execution started on. */
  readonly fingerprint: string;
}

export interface DurableRecord {
  readonly policy: Exclude<InterruptPolicy, "fail">;
  readonly attempt: number;
  /** Calls journaled when the attempt started. */
  readonly progress: number;
  readonly start: DurableStart;
  /** When the run's first unanswered interrupt was made, if one is waiting. */
  readonly waitingSince: number | null;
  /** Time the run has spent waiting for answers, which its timeout leaves out. */
  readonly waitedMs: number;
}

/** A call waiting for an answer, as `pending()` lists it. */
export interface WaitingCall {
  readonly id: string;
  readonly seq: number;
  readonly payload: unknown;
  readonly since: number;
}

interface JournalEntry {
  readonly seq: number;
  readonly key: string;
  readonly label: string;
  // An interrupted call is `waiting` until it's answered, then `answered`
  // until the resumed run makes it again.
  readonly state: "executing" | "applied" | "waiting" | "answered";
  readonly response: string | null;
  readonly answer: string | null;
  readonly at: number | null;
  readonly ordinal: number | null;
}

export type JournalStep =
  | {
      readonly kind: "replay";
      readonly response: BridgeResponse;
      readonly at: number;
      /** Where this response came in the order responses were delivered. */
      readonly ordinal: number;
    }
  | {
      readonly kind: "live";
      readonly seq: number;
      /** The call was in flight when the run was interrupted. */
      readonly rerun: boolean;
      /** The answer to the call's interrupt, which it now returns. */
      readonly answer?: { readonly value: unknown };
    }
  | { readonly kind: "diverge"; readonly message: string };

export const DURABLE_TABLES = [
  "workspace_runtime_durable",
  "workspace_runtime_durable_chunks",
  "workspace_runtime_journal",
  "workspace_runtime_journal_chunks",
  "workspace_runtime_schedule",
] as const;

/** Most events one log chunk may carry. */
const MAX_LOG_CHUNK = 65536;

// The tables hold state for running executions only. A change to their
// shape should rename them rather than migrate: every backend creates
// them on connect, whether or not it uses them, and CREATE TABLE IF NOT
// EXISTS leaves an older table as it was.
export function createDurableTables(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_runtime_durable (
      backend TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      policy TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      waiting_since INTEGER,
      waited_ms INTEGER NOT NULL DEFAULT 0,
      progress INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (backend, execution_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_runtime_durable_chunks (
      backend TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (backend, execution_id, idx)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_runtime_journal (
      backend TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      call_key TEXT NOT NULL,
      label TEXT NOT NULL,
      state TEXT NOT NULL,
      response TEXT,
      payload TEXT,
      answer TEXT,
      at INTEGER,
      ordinal INTEGER,
      PRIMARY KEY (backend, execution_id, seq)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_runtime_journal_chunks (
      backend TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (backend, execution_id, seq, idx)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS workspace_runtime_schedule (
      backend TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      events TEXT NOT NULL,
      PRIMARY KEY (backend, execution_id, position)
    )
  `);
}

export function saveDurableStart(
  db: Database,
  backend: string,
  id: string,
  policy: Exclude<InterruptPolicy, "fail">,
  start: DurableStart,
): void {
  const text = JSON.stringify(start);
  db.transactionSync(() => {
    clearDurable(db, backend, id);
    db.run(
      `INSERT INTO workspace_runtime_durable (backend, execution_id, policy, attempt)
       VALUES (?, ?, ?, 1)`,
      backend,
      id,
      policy,
    );
    for (let offset = 0, idx = 0; offset < text.length; offset += CHUNK_CHARACTERS, idx += 1) {
      db.run(
        `INSERT INTO workspace_runtime_durable_chunks (backend, execution_id, idx, data)
         VALUES (?, ?, ?, ?)`,
        backend,
        id,
        idx,
        text.slice(offset, offset + CHUNK_CHARACTERS),
      );
    }
  });
}

export function loadDurable(db: Database, backend: string, id: string): DurableRecord | undefined {
  const row = db.one<{
    policy: string;
    attempt: number;
    progress: number;
    waiting_since: number | null;
    waited_ms: number;
  }>(
    `SELECT policy, attempt, progress, waiting_since, waited_ms FROM workspace_runtime_durable
     WHERE backend = ? AND execution_id = ?`,
    backend,
    id,
  );
  if (!row || (row.policy !== "restart" && row.policy !== "replay")) return undefined;
  const chunks = db.all<{ data: string }>(
    `SELECT data FROM workspace_runtime_durable_chunks
     WHERE backend = ? AND execution_id = ? ORDER BY idx`,
    backend,
    id,
  );
  try {
    const start = JSON.parse(chunks.map((chunk) => chunk.data).join("")) as DurableStart;
    return {
      policy: row.policy,
      attempt: Number(row.attempt),
      progress: Number(row.progress),
      start,
      waitingSince: row.waiting_since === null ? null : Number(row.waiting_since),
      waitedMs: Number(row.waited_ms),
    };
  } catch {
    return undefined;
  }
}

export function recordAttempt(
  db: Database,
  backend: string,
  id: string,
  attempt: number,
  progress: number,
): void {
  db.run(
    `UPDATE workspace_runtime_durable SET attempt = ?, progress = ?
     WHERE backend = ? AND execution_id = ?`,
    attempt,
    progress,
    backend,
    id,
  );
}

/**
 * Answer a waiting call. Returns how many of the run's calls are still
 * waiting, or `undefined` if this one wasn't. Once none are, the run's
 * wait ends and its timeout counts again.
 */
export function answerCall(
  db: Database,
  backend: string,
  id: string,
  seq: number,
  value: unknown,
): number | undefined {
  const answered = db.all(
    `UPDATE workspace_runtime_journal SET state = 'answered', answer = ?
     WHERE backend = ? AND execution_id = ? AND seq = ? AND state = 'waiting'
     RETURNING seq`,
    encodeLimited(value, "answer"),
    backend,
    id,
    seq,
  );
  if (answered.length === 0) return undefined;
  const waiting = Number(
    db.one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM workspace_runtime_journal
       WHERE backend = ? AND execution_id = ? AND state = 'waiting'`,
      backend,
      id,
    )?.count ?? 0,
  );
  if (waiting === 0) {
    db.run(
      `UPDATE workspace_runtime_durable
       SET waited_ms = waited_ms + MAX(0, ? - waiting_since), waiting_since = NULL
       WHERE backend = ? AND execution_id = ? AND waiting_since IS NOT NULL`,
      Date.now(),
      backend,
      id,
    );
  }
  return waiting;
}

/** Every call of this backend's runs that's waiting for an answer. */
export function waitingCalls(db: Database, backend: string): WaitingCall[] {
  return db
    .all<{ execution_id: string; seq: number; payload: string; waiting_since: number }>(
      `SELECT j.execution_id, j.seq, j.payload, d.waiting_since
       FROM workspace_runtime_journal j
       JOIN workspace_runtime_durable d
         ON d.backend = j.backend AND d.execution_id = j.execution_id
       WHERE j.backend = ? AND j.state = 'waiting'
       ORDER BY d.waiting_since, j.execution_id, j.seq`,
      backend,
    )
    .map((row) => ({
      id: row.execution_id,
      seq: Number(row.seq),
      payload: decodeValue(row.payload),
      since: Number(row.waiting_since),
    }));
}

/** How many calls a run has journaled. */
export function journalProgress(db: Database, backend: string, id: string): number {
  const row = db.one<{ calls: number }>(
    `SELECT COUNT(*) AS calls FROM workspace_runtime_journal
     WHERE backend = ? AND execution_id = ? AND state = 'applied'`,
    backend,
    id,
  );
  return Number(row?.calls ?? 0);
}

export function clearJournal(db: Database, backend: string, id: string): void {
  for (const table of [
    "workspace_runtime_journal",
    "workspace_runtime_journal_chunks",
    "workspace_runtime_schedule",
  ]) {
    db.run(`DELETE FROM ${table} WHERE backend = ? AND execution_id = ?`, backend, id);
  }
}

export function clearDurable(db: Database, backend: string, id: string): void {
  db.run(
    `DELETE FROM workspace_runtime_durable WHERE backend = ? AND execution_id = ?`,
    backend,
    id,
  );
  db.run(
    `DELETE FROM workspace_runtime_durable_chunks WHERE backend = ? AND execution_id = ?`,
    backend,
    id,
  );
  clearJournal(db, backend, id);
}

/**
 * The capability calls of one execution, backed by SQLite.
 *
 * A journal opened over an earlier attempt's entries answers matching
 * calls from them. Calls match by name and arguments, in the order they
 * were made, rather than by position, so independent calls that finish
 * in a different order on replay still match.
 */
export class ExecutionJournal implements BridgeJournal {
  readonly #db: Database;
  readonly #backend: string;
  readonly #id: string;
  readonly #entries: JournalEntry[];
  readonly #consumed = new Set<number>();
  readonly #onDiverge: (message: string) => void;
  #nextSeq: number;
  #lastOrdinal: number;
  #unanswered: number;
  readonly #log: number[];

  constructor(
    db: Database,
    backend: string,
    id: string,
    onDiverge: (message: string) => void = () => undefined,
  ) {
    this.#db = db;
    this.#onDiverge = onDiverge;
    this.#backend = backend;
    this.#id = id;
    this.#entries = db
      .all<{
        seq: number;
        call_key: string;
        label: string;
        state: string;
        response: string | null;
        answer: string | null;
        at: number | null;
        ordinal: number | null;
      }>(
        `SELECT seq, call_key, label, state, response, answer, at, ordinal
         FROM workspace_runtime_journal
         WHERE backend = ? AND execution_id = ? ORDER BY seq`,
        backend,
        id,
      )
      .map((row) => ({
        seq: Number(row.seq),
        key: row.call_key,
        label: row.label,
        state: journalState(row.state, row.response),
        // An empty response marks one stored in chunks.
        response: row.response === "" ? this.#chunkedResponse(Number(row.seq)) : row.response,
        answer: row.answer,
        at: row.at === null ? null : Number(row.at),
        ordinal: row.ordinal === null ? null : Number(row.ordinal),
      }));
    this.#nextSeq = (this.#entries.at(-1)?.seq ?? 0) + 1;
    const applied = this.#entries.filter((entry) => entry.state === "applied");
    this.#unanswered = applied.length;
    this.#lastOrdinal = applied.reduce((last, entry) => Math.max(last, entry.ordinal ?? 0), 0);
    this.#log = this.#loadLog();
  }

  /**
   * The order the run saw its events in so far: a positive number is the
   * response with that ordinal, a negative one the timer set in that
   * place firing. The isolate replays its events in this order.
   */
  schedule(): number[] {
    return [...this.#log];
  }

  /**
   * Save part of the isolate's event log. Chunks can arrive out of order,
   * since calls and output travel separately, so each says where it goes.
   */
  record(position: unknown, events: unknown): void {
    if (
      !Number.isSafeInteger(position) ||
      (position as number) < 0 ||
      !Array.isArray(events) ||
      events.length === 0 ||
      events.length > MAX_LOG_CHUNK ||
      !events.every((event) => Number.isSafeInteger(event) && event !== 0)
    ) {
      throw new Error("Workspace execution sent a malformed event log.");
    }
    this.#db.run(
      `INSERT OR IGNORE INTO workspace_runtime_schedule (backend, execution_id, position, events)
       VALUES (?, ?, ?, ?)`,
      this.#backend,
      this.#id,
      position as number,
      JSON.stringify(events),
    );
  }

  #chunkedResponse(seq: number): string {
    return this.#db
      .all<{ data: string }>(
        `SELECT data FROM workspace_runtime_journal_chunks
         WHERE backend = ? AND execution_id = ? AND seq = ? ORDER BY idx`,
        this.#backend,
        this.#id,
        seq,
      )
      .map((chunk) => chunk.data)
      .join("");
  }

  // The log as far as it runs without a gap. A chunk that arrived after
  // one lost to the interruption describes events nobody saw, so it's
  // dropped, and the replay logs those positions afresh.
  #loadLog(): number[] {
    const rows = this.#db.all<{ position: number; events: string }>(
      `SELECT position, events FROM workspace_runtime_schedule
       WHERE backend = ? AND execution_id = ? ORDER BY position`,
      this.#backend,
      this.#id,
    );
    const log: number[] = [];
    for (const row of rows) {
      if (Number(row.position) !== log.length) break;
      log.push(...(JSON.parse(row.events) as number[]));
    }
    this.#db.run(
      `DELETE FROM workspace_runtime_schedule
       WHERE backend = ? AND execution_id = ? AND position >= ?`,
      this.#backend,
      this.#id,
      log.length,
    );
    return log;
  }

  /**
   * Decide how to answer one call. A live call is journaled as executing
   * before it runs, and `commit()` records its response.
   */
  begin(name: string, args: readonly unknown[]): JournalStep {
    const key = callKey(name, args);
    const label = describeCall(name, args);
    const entry = this.#entries.find((item) => !this.#consumed.has(item.seq) && item.key === key);
    if (entry !== undefined) {
      this.#consumed.add(entry.seq);
      if (entry.state === "applied") {
        this.#unanswered -= 1;
        return {
          kind: "replay",
          response: decodeValue(entry.response ?? "null") as BridgeResponse,
          at: entry.at ?? 0,
          ordinal: entry.ordinal ?? 0,
        };
      }
      const answer =
        entry.answer === null ? undefined : { value: decodeValue(entry.answer) as unknown };
      // An answered call runs again by design, so it isn't a rerun until
      // it's under way.
      if (entry.state === "answered") {
        this.#db.run(
          `UPDATE workspace_runtime_journal SET state = 'executing'
           WHERE backend = ? AND execution_id = ? AND seq = ?`,
          this.#backend,
          this.#id,
          entry.seq,
        );
        return { kind: "live", seq: entry.seq, rerun: false, answer };
      }
      // The call was in flight when the execution was interrupted, so its
      // response never reached the code. Run it again.
      return { kind: "live", seq: entry.seq, rerun: true, answer };
    }
    if (this.#unanswered > 0) {
      return {
        kind: "diverge",
        message:
          "The execution took a different path when it resumed after an interruption: " +
          `it called ${label}, but the next call it made before was ${this.expectedCall()}.`,
      };
    }
    const seq = this.#nextSeq++;
    this.#db.run(
      `INSERT INTO workspace_runtime_journal
         (backend, execution_id, seq, call_key, label, state, response, at)
       VALUES (?, ?, ?, ?, ?, 'executing', NULL, NULL)`,
      this.#backend,
      this.#id,
      seq,
      key,
      label,
    );
    return { kind: "live", seq, rerun: false };
  }

  /** Record a live call's response, before the isolate sees it. */
  commit(seq: number, response: BridgeResponse): { at: number; ordinal: number } {
    const at = Date.now();
    this.#lastOrdinal += 1;
    const text = encodeValue(response);
    const chunked = text.length > CHUNK_CHARACTERS;
    if (chunked) {
      for (let offset = 0, idx = 0; offset < text.length; offset += CHUNK_CHARACTERS, idx += 1) {
        this.#db.run(
          `INSERT OR REPLACE INTO workspace_runtime_journal_chunks
             (backend, execution_id, seq, idx, data)
           VALUES (?, ?, ?, ?, ?)`,
          this.#backend,
          this.#id,
          seq,
          idx,
          text.slice(offset, offset + CHUNK_CHARACTERS),
        );
      }
    }
    this.#db.run(
      `UPDATE workspace_runtime_journal SET state = 'applied', response = ?, at = ?, ordinal = ?
       WHERE backend = ? AND execution_id = ? AND seq = ?`,
      chunked ? "" : text,
      at,
      this.#lastOrdinal,
      this.#backend,
      this.#id,
      seq,
    );
    return { at, ordinal: this.#lastOrdinal };
  }

  /**
   * Mark a live call as waiting for an answer, and return when its run
   * started waiting. Its response is never committed: the run is
   * released, and the call runs again once answered.
   */
  interrupt(seq: number, payload: unknown): number {
    this.#db.run(
      `UPDATE workspace_runtime_journal SET state = 'waiting', payload = ?
       WHERE backend = ? AND execution_id = ? AND seq = ?`,
      encodeLimited(payload, "payload"),
      this.#backend,
      this.#id,
      seq,
    );
    const [row] = this.#db.all<{ waiting_since: number }>(
      `UPDATE workspace_runtime_durable SET waiting_since = COALESCE(waiting_since, ?)
       WHERE backend = ? AND execution_id = ?
       RETURNING waiting_since`,
      Date.now(),
      this.#backend,
      this.#id,
    );
    return Number(row?.waiting_since ?? Date.now());
  }

  diverged(message: string): void {
    this.#onDiverge(message);
  }

  /** The isolate is waiting for a call the replay never made. */
  stalled(): void {
    const expected = this.expectedCall();
    const where =
      expected === undefined
        ? "before reaching the point it was interrupted at"
        : `before calling ${expected}`;
    this.#onDiverge(
      `The execution took a different path when it resumed after an interruption: it stopped ${where}.`,
    );
  }

  /** The first journaled call not answered yet. */
  expectedCall(): string | undefined {
    return this.#entries.find((item) => item.state === "applied" && !this.#consumed.has(item.seq))
      ?.label;
  }
}

/** A short, readable form of a call for messages: its name and arguments. */
export function describeCall(name: string, args: readonly unknown[]): string {
  const text = `${name}(${args.map(describeValue).join(", ")})`;
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

function describeValue(value: unknown): string {
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

/** A stable identity for a call: its name and its arguments. */
export function callKey(name: string, args: readonly unknown[]): string {
  return digest(`${name}\n${stableStringify(args)}`);
}

/** Identify runtime code by the text of its generated modules. */
export function fingerprint(parts: readonly string[]): string {
  return `v${JOURNAL_VERSION}:${digest(parts.join("\u0000"))}`;
}

// JSON with sorted object keys and tagged byte arrays, so equal values
// always produce equal text.
function stableStringify(value: unknown): string {
  if (value instanceof Uint8Array) return JSON.stringify({ [BYTES_TAG]: toBase64(value) });
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// Two 53-bit cyrb53 hashes with different seeds, plus the length.
function digest(text: string): string {
  return `${cyrb53(text, 0)}${cyrb53(text, 0x9e3779b9)}:${text.length}`;
}

function cyrb53(text: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, "0");
}

function journalState(state: string, response: string | null): JournalEntry["state"] {
  if (state === "applied") return response === null ? "executing" : "applied";
  return state === "waiting" || state === "answered" ? state : "executing";
}

// Interrupt payloads and answers are stored in one row each.
const MAX_WAIT_CHARACTERS = CHUNK_CHARACTERS;

function encodeLimited(value: unknown, what: string): string {
  const text = encodeValue(value);
  if (text.length > MAX_WAIT_CHARACTERS) {
    throw new Error(
      `An interrupt's ${what} must encode to at most ${MAX_WAIT_CHARACTERS} characters.`,
    );
  }
  return text;
}

const BYTES_TAG = "\u0000bytes";

export function encodeValue(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Uint8Array ? { [BYTES_TAG]: toBase64(item) } : item,
  );
}

export function decodeValue(text: string): unknown {
  return JSON.parse(text, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const tagged = (item as Record<string, unknown>)[BYTES_TAG];
      if (typeof tagged === "string" && Object.keys(item).length === 1) return fromBase64(tagged);
    }
    return item;
  });
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
