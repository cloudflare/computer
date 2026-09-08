// Durable REPL session host.
//
// A session is a log, not a process: committed cells and their recorded
// effects live in the workspace's Durable Object SQLite. Every eval builds
// a fresh isolate containing all cells (dynamic isolates ban runtime eval),
// replays committed cells against the log, and records the new cell's
// effects. The isolate is a disposable cache; the log is the truth — which
// is why sessions survive eviction, deploys, and idle at zero cost.
//
// Evals on one session are serialized (concurrent calls queue in arrival
// order); parallelism is what forks are for.

import type { Database } from "@cloudflare/dofs";

import type { WorkspaceRuntimeLoader } from "../runtime/types.js";
import { ReplCapabilityBridge } from "./bridge.js";
import type { ReplCapability, ReplCapabilityShape } from "./capability.js";
import {
  REPL_CELLS_MODULE,
  REPL_RUNNER_MODULE,
  replCellModule,
  replCellModuleName,
  replCellsModule,
  replRunnerModule,
} from "./runner.js";
import { transformCell } from "./transform.js";
import type { ReplEffect, ReplExecutionError, ReplExecutionResult, ReplLogEntry } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_COMPATIBILITY_DATE = "2026-05-23";

export interface ReplSessionOptions {
  name: string;
  db: Database;
  loader: WorkspaceRuntimeLoader;
  /**
   * Capabilities granted to this attachment, by global name. Grants are
   * attach-time: they apply to evals started after this attach. Committed
   * cells always replay against the grants they were recorded with.
   */
  capabilities?: Record<string, ReplCapability>;
  timeoutMs?: number;
  /**
   * Per-effect recorded-value ceiling in JSON bytes (default 1 MiB).
   * Oversized capability results are rejected, never truncated — the error
   * tells the model to write large data to workspace files and pass paths.
   * Lower it to push data toward files earlier (every recorded effect is
   * reloaded on every future eval, so lean logs keep evals fast) or when a
   * harness meters session weight per tenant. There is little headroom to
   * raise it: effects are SQLite rows, and Durable Object SQLite caps a
   * row at ~2 MB.
   */
  maxEffectBytes?: number;
  compatibilityDate?: string;
  now?: () => number;
}

export interface ReplEvalOptions {
  timeoutMs?: number;
}

interface CommittedCell {
  code: string;
  transformed: string;
  effects: ReplEffect[];
  /** Grant shapes (with data snapshots) this cell was recorded under. */
  grants: Record<string, ReplCapabilityShape>;
}

interface RunOutcome {
  ok: boolean;
  phase?: "replay" | "cell";
  error?: ReplExecutionError;
  effects?: ReplEffect[];
  logs?: { entries: ReplLogEntry[]; dropped?: number };
  results?: Array<{ text: string; value?: unknown }>;
  hasValue?: boolean;
  value?: unknown;
}

interface RunnerGrants {
  perCell: Array<Record<string, ReplCapabilityShape>>;
  current: Record<string, ReplCapabilityShape>;
}

interface RunnerEntrypoint {
  run(
    effectLog: ReplEffect[][],
    bridge: ReplCapabilityBridge,
    grants: RunnerGrants,
  ): Promise<RunOutcome>;
  [Symbol.dispose]?: () => void;
}

const EMPTY_LOGS = () => ({ entries: [] });

export class ReplSession {
  readonly name: string;
  readonly #db: Database;
  readonly #loader: WorkspaceRuntimeLoader;
  readonly #timeoutMs: number;
  readonly #compatibilityDate: string;
  readonly #now: () => number;
  readonly #maxEffectBytes: number | undefined;
  // Session-lifetime capability bridge: attach() swaps its root grants,
  // while handles the session has acquired persist until host restart.
  readonly #bridge: ReplCapabilityBridge;
  // Committed log, lazily loaded from SQLite; the DO is the single writer.
  #cells: CommittedCell[] | undefined;
  // Tail promise serializing evals on this session.
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: ReplSessionOptions) {
    this.name = options.name;
    this.#db = options.db;
    this.#loader = options.loader;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#compatibilityDate = options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE;
    this.#now = options.now ?? Date.now;
    this.#maxEffectBytes = options.maxEffectBytes;
    this.#bridge = new ReplCapabilityBridge(
      options.capabilities ?? {},
      this.#maxEffectBytes === undefined ? {} : { maxEffectBytes: this.#maxEffectBytes },
    );
    initializeReplSchema(this.#db);
  }

  /**
   * Replace this session's grants. Applies to evals started afterwards;
   * an eval already in flight keeps the grants it started with. Handles
   * acquired earlier stay alive, but are only callable while the root
   * grant they descend from is still attached.
   */
  attach(capabilities: Record<string, ReplCapability>): void {
    this.#bridge.attach(capabilities);
  }

  eval(code: string, options?: ReplEvalOptions): Promise<ReplExecutionResult> {
    const run = this.#tail.then(() => this.#eval(code, options), () => this.#eval(code, options));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #eval(code: string, options?: ReplEvalOptions): Promise<ReplExecutionResult> {
    const cells = this.#load();
    const executionCount = cells.length + 1;
    const bridge = this.#bridge;
    // Pin the attachment's grant shapes for this whole eval: an attach()
    // racing a queued eval must not swap grants under a running cell or
    // its commit row. (attach() replaces the shapes object wholesale, so
    // this reference stays internally consistent.)
    const grantShapes = bridge.shapes();

    let transformed: string;
    try {
      transformed = transformCell(code);
    } catch (error) {
      return {
        code,
        logs: EMPTY_LOGS(),
        results: [],
        error: {
          name: error instanceof SyntaxError ? "SyntaxError" : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
        executionCount,
      };
    }

    const timeoutMs = options?.timeoutMs ?? this.#timeoutMs;
    const outcome = await this.#run(cells, transformed, timeoutMs, bridge, grantShapes);

    if (outcome.ok) {
      this.#commit(cells, {
        code,
        transformed,
        effects: outcome.effects ?? [],
        grants: grantShapes,
      });
      const result: ReplExecutionResult = {
        code,
        logs: outcome.logs ?? EMPTY_LOGS(),
        results: outcome.results ?? [],
        executionCount,
      };
      if (outcome.hasValue === true) result.value = outcome.value;
      return result;
    }

    // Failed cells never enter the log; the session stays as it was.
    return {
      code,
      logs: outcome.logs ?? EMPTY_LOGS(),
      results: outcome.results ?? [],
      error: outcome.error ?? { name: "Error", message: "REPL evaluation failed." },
      executionCount,
    };
  }

  async #run(
    cells: CommittedCell[],
    transformed: string,
    timeoutMs: number,
    bridge: ReplCapabilityBridge,
    grantShapes: Record<string, ReplCapabilityShape>,
  ): Promise<RunOutcome> {
    const modules: Record<string, string> = {
      [REPL_RUNNER_MODULE]: replRunnerModule(),
      [REPL_CELLS_MODULE]: replCellsModule(cells.length + 1),
    };
    cells.forEach((cell, index) => {
      modules[replCellModuleName(index + 1)] = replCellModule(cell.transformed);
    });
    modules[replCellModuleName(cells.length + 1)] = replCellModule(transformed);

    const worker = this.#loader.load({
      compatibilityDate: this.#compatibilityDate,
      limits: { cpuMs: timeoutMs },
      mainModule: REPL_RUNNER_MODULE,
      modules,
      globalOutbound: null,
    });
    const entrypoint = worker.getEntrypoint(undefined, {
      limits: { cpuMs: timeoutMs },
    }) as RunnerEntrypoint;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<RunOutcome>((resolve) => {
      timer = setTimeout(() => resolve(timeoutOutcome(timeoutMs)), timeoutMs);
    });
    try {
      const effectLog = cells.map((cell) => cell.effects);
      const grants: RunnerGrants = {
        perCell: cells.map((cell) => cell.grants),
        current: grantShapes,
      };
      const run = Promise.resolve().then(() => entrypoint.run(effectLog, bridge, grants));
      // If the timeout wins the race, the losing run promise rejects later
      // (its isolate is disposed) with nobody awaiting it — swallow that so
      // it can't surface as an unhandled rejection.
      run.catch(() => undefined);
      return await Promise.race([run, timeout]);
    } catch (error) {
      // Loader/runtime-level failure: the isolate was killed by its CPU
      // limit, or workerd proved the cell can never finish (hung promise).
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("exceeded its CPU limit") ||
        message.includes("hung and would never generate a response")
      ) {
        return timeoutOutcome(timeoutMs);
      }
      return {
        ok: false,
        phase: "cell",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message,
        },
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      disposeQuietly(entrypoint);
      disposeQuietly(worker as { [Symbol.dispose]?: () => void });
    }
  }

  #load(): CommittedCell[] {
    if (this.#cells !== undefined) return this.#cells;
    const rows = this.#db.all<{ seq: number; code: string; transformed: string; grants: string }>(
      "SELECT seq, code, transformed, grants FROM repl_cells WHERE session = ? ORDER BY seq",
      this.name,
    );
    const effectRows = this.#db.all<{ cell_seq: number; kind: string; value: string }>(
      "SELECT cell_seq, kind, value FROM repl_effects WHERE session = ? ORDER BY cell_seq, call_seq",
      this.name,
    );
    const effectsBySeq = new Map<number, ReplEffect[]>();
    for (const row of effectRows) {
      const list = effectsBySeq.get(row.cell_seq) ?? [];
      list.push({ kind: row.kind, value: (JSON.parse(row.value) as { v?: unknown }).v });
      effectsBySeq.set(row.cell_seq, list);
    }
    this.#cells = rows.map((row) => ({
      code: row.code,
      transformed: row.transformed,
      effects: effectsBySeq.get(row.seq) ?? [],
      grants: JSON.parse(row.grants) as Record<string, ReplCapabilityShape>,
    }));
    return this.#cells;
  }

  #commit(cells: CommittedCell[], cell: CommittedCell): void {
    // Effect values are stored verbatim — they are replay input and must
    // never be truncated. Shim effects are ≤36-byte scalars by
    // construction; capability results are size-guarded at the bridge,
    // which REJECTS the call (failing the cell) rather than truncating.
    const seq = cells.length + 1;
    this.#db.transactionSync(() => {
      this.#db.run(
        "INSERT INTO repl_cells (session, seq, code, transformed, grants, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        this.name,
        seq,
        cell.code,
        cell.transformed,
        JSON.stringify(cell.grants),
        this.#now(),
      );
      cell.effects.forEach((effect, index) => {
        this.#db.run(
          "INSERT INTO repl_effects (session, cell_seq, call_seq, kind, value) VALUES (?, ?, ?, ?, ?)",
          this.name,
          seq,
          index,
          effect.kind,
          JSON.stringify({ v: effect.value }),
        );
      });
    });
    cells.push(cell);
  }
}

function timeoutOutcome(timeoutMs: number): RunOutcome {
  return {
    ok: false,
    phase: "cell",
    error: {
      name: "TimeoutError",
      message:
        `REPL evaluation did not finish within ${timeoutMs}ms. The cell was not ` +
        "committed; split long work into smaller cells or raise timeoutMs.",
      kind: "timeout",
    },
  };
}

function initializeReplSchema(db: Database): void {
  db.run(
    `CREATE TABLE IF NOT EXISTS repl_cells (
      session TEXT NOT NULL,
      seq INTEGER NOT NULL,
      code TEXT NOT NULL,
      transformed TEXT NOT NULL,
      grants TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session, seq)
    )`,
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS repl_effects (
      session TEXT NOT NULL,
      cell_seq INTEGER NOT NULL,
      call_seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (session, cell_seq, call_seq)
    )`,
  );
}

function disposeQuietly(target: { [Symbol.dispose]?: () => void }): void {
  try {
    target[Symbol.dispose]?.();
  } catch {
    // Disposal is best-effort; the isolate is disposable by design.
  }
}
