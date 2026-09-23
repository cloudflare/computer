// Isolate-side runner for REPL sessions.
//
// This module's source string ships as the main module of every REPL
// isolate, alongside one module per cell. It executes all cells in order:
// committed cells replay in "serve" mode (every recorded effect answered
// from the log — nothing external fires, randomness and time reproduce
// exactly), and the new cell runs in "record" mode (effects execute for
// real and are captured for the log).
//
// Replay divergence — a served effect whose kind doesn't match, or effects
// left unconsumed after a cell — is a loud, structured failure: silent
// corruption is never an option.
//
// Recorded nondeterminism surface: Math.random, Date.now,
// no-arg new Date() and Date(), crypto.randomUUID, crypto.getRandomValues,
// performance.now. WeakRef, FinalizationRegistry (GC timing) and caches
// (state shared across isolates) are removed so use fails loudly instead
// of silently diverging. The isolate is otherwise hermetic: globalOutbound
// is null (fetch/WebSocket/EventSource fail deterministically), no
// nodejs_compat, performance.timeOrigin is pinned to 0 by workerd, and
// Intl (UTC) / navigator are constants.
//
// Known unshimmed nondeterminism, documented rather than recorded:
//   - crypto.subtle randomized ops (e.g. generateKey): their results are
//     not plainly loggable; use them through a granted capability, or a
//     future recorder that can store exported key material.
//   - timers (setTimeout / scheduler.wait): ordering replays
//     deterministically, but replay re-waits real delays — committed
//     sleeps make replay slow, never wrong.

export const REPL_RUNNER_MODULE = "__repl_runner__.js";
export const REPL_CELLS_MODULE = "__repl_cells__.js";

export function replCellModuleName(seq: number): string {
  return `__repl_cell_${seq}__.js`;
}

/** Wrap transformed cell code as a module exporting one async cell function. */
export function replCellModule(transformed: string): string {
  return `export default async function cell() {\n${transformed}\n}`;
}

/** Index module importing every cell in order. */
export function replCellsModule(count: number): string {
  const imports: string[] = [];
  const names: string[] = [];
  for (let seq = 1; seq <= count; seq++) {
    imports.push(`import c${seq} from "./${replCellModuleName(seq)}";`);
    names.push(`c${seq}`);
  }
  return `${imports.join("\n")}\nexport default [${names.join(", ")}];`;
}

const MAX_LOG_ENTRIES = 1_000;
const MAX_LOG_ENTRY_CHARS = 8_192;

// The runner source. A template-built string (matching how the
// worker-javascript backend ships its runtime module) so the package build
// needs no extra bundling step for isolate-side code.
export function replRunnerModule(): string {
  return `
import { WorkerEntrypoint } from "cloudflare:workers";
import cells from "./${REPL_CELLS_MODULE}";

const fx = { mode: "record", queue: [], recorded: [] };
const DIVERGENCE = "__repl_replay_divergence__: ";

const realRandom = Math.random.bind(Math);
const realNow = Date.now.bind(Date);
const realRandomUUID = crypto.randomUUID ? crypto.randomUUID.bind(crypto) : undefined;
const realGetRandomValues = crypto.getRandomValues ? crypto.getRandomValues.bind(crypto) : undefined;
const RealDate = Date;

// Divergence checks compare the full call identity. The current shims take
// no arguments, so kind alone is that identity; future effect sources that
// carry arguments (capability calls) must extend this to an args
// comparison — divergence stays a hard error, never a silent re-execution.
function effect(kind, make) {
  if (fx.mode === "record") {
    const value = make();
    fx.recorded.push({ kind, value });
    return value;
  }
  const entry = fx.queue.shift();
  if (!entry || entry.kind !== kind) {
    throw new Error(
      DIVERGENCE + "expected a recorded " + JSON.stringify(kind) +
      " effect, log had " + (entry ? JSON.stringify(entry.kind) : "nothing") +
      ". Committed cells must replay exactly; this session's log no longer matches its code."
    );
  }
  return entry.value;
}

Math.random = () => effect("random", realRandom);
if (realRandomUUID) crypto.randomUUID = () => effect("uuid", realRandomUUID);

// crypto.getRandomValues fills any integer TypedArray; record the raw bytes
// so serve mode can refill an identical view without touching the CSPRNG.
if (realGetRandomValues) {
  crypto.getRandomValues = (array) => {
    const bytes = effect("random-bytes", () => {
      realGetRandomValues(array);
      return Array.from(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    });
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
    return array;
  };
}

// Clock shims. A no-arg new Date() (and bare Date()) reads the clock, so it
// records like Date.now; constructions from explicit arguments pass through
// untouched. Instances stay genuine Dates (same prototype), so instanceof,
// methods, and structured clone are unaffected.
function ReplDate(...args) {
  if (!new.target) return new ReplDate().toString();
  if (args.length === 0) return Reflect.construct(RealDate, [effect("now", realNow)], new.target);
  return Reflect.construct(RealDate, args, new.target);
}
ReplDate.prototype = RealDate.prototype;
Object.setPrototypeOf(ReplDate, RealDate);
Object.defineProperty(ReplDate, "name", { value: "Date", configurable: true });
ReplDate.now = () => effect("now", realNow);
globalThis.Date = ReplDate;

if (globalThis.performance && typeof performance.now === "function") {
  const realPerfNow = performance.now.bind(performance);
  performance.now = () => effect("perf-now", realPerfNow);
}

// GC timing (WeakRef/FinalizationRegistry) and cross-isolate cache state
// cannot replay; remove the globals so use is a loud ReferenceError.
for (const name of ["WeakRef", "FinalizationRegistry", "caches"]) {
  try { delete globalThis[name]; } catch {}
  if (name in globalThis) {
    try { Object.defineProperty(globalThis, name, { value: undefined, configurable: true }); } catch {}
  }
}

// console capture: one ordered stream, levels preserved. Display output
// only — never replay input — so capping it here is safe (recorded effect
// values are stored verbatim; size guards on those must reject, not
// truncate). Entries past the cap are counted in logs.dropped.
const logs = { entries: [], dropped: 0 };
function snapshotLogs() {
  const snapshot = { entries: logs.entries.slice() };
  if (logs.dropped > 0) snapshot.dropped = logs.dropped;
  return snapshot;
}
function capture(level) {
  return (...args) => {
    if (logs.entries.length >= ${MAX_LOG_ENTRIES}) {
      logs.dropped++;
      return;
    }
    const text = args.map((a) => (typeof a === "string" ? a : inspect(a, 0))).join(" ");
    logs.entries.push({ level, text: text.length > ${MAX_LOG_ENTRY_CHARS} ? text.slice(0, ${MAX_LOG_ENTRY_CHARS}) + "…" : text });
  };
}
for (const level of ["log", "info", "debug", "warn", "error"]) {
  console[level] = capture(level);
}

function inspect(value, depth) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return depth === 0 ? value : JSON.stringify(value);
  if (t === "number" || t === "boolean" || t === "bigint" || t === "undefined") return String(value);
  if (t === "symbol") return value.toString();
  if (t === "function") return "[Function: " + (value.name || "anonymous") + "]";
  if (depth > 4) return "[…]";
  if (Array.isArray(value)) return "[" + value.map((v) => inspect(v, depth + 1)).join(", ") + "]";
  if (value instanceof Error) return (value.stack || value.name + ": " + value.message);
  if (value instanceof Map) {
    return "Map(" + value.size + ") {" +
      [...value.entries()].map(([k, v]) => " " + inspect(k, depth + 1) + " => " + inspect(v, depth + 1)).join(",") + " }";
  }
  if (value instanceof Set) {
    return "Set(" + value.size + ") {" + [...value.values()].map((v) => " " + inspect(v, depth + 1)).join(",") + " }";
  }
  const name = value.constructor && value.constructor.name !== "Object" ? value.constructor.name + " " : "";
  const entries = Object.keys(value).map((k) => k + ": " + inspect(value[k], depth + 1));
  return name + "{ " + entries.join(", ") + " }";
}

function describeError(error, kind) {
  const isError = error instanceof Error;
  return {
    name: isError ? error.name : "Error",
    message: String(isError ? error.message : error),
    traceback: isError && error.stack ? String(error.stack) : undefined,
    kind,
  };
}

export default class ReplRunner extends WorkerEntrypoint {
  // Replay every committed cell against its recorded effects, then run the
  // final cell in record mode. Returns a structured outcome; never throws
  // for cell-level failures (structure survives the RPC boundary, thrown
  // errors don't).
  async run(effectLog) {
    for (let i = 0; i < cells.length - 1; i++) {
      fx.mode = "serve";
      fx.queue = (effectLog[i] || []).slice();
      try {
        await cells[i]();
      } catch (error) {
        return { ok: false, phase: "replay", error: describeError(error, "replay-divergence") };
      }
      if (fx.queue.length > 0) {
        return {
          ok: false,
          phase: "replay",
          error: {
            name: "Error",
            message: DIVERGENCE + fx.queue.length + " recorded effects were never consumed replaying cell " + (i + 1) + ".",
            kind: "replay-divergence",
          },
        };
      }
    }

    fx.mode = "record";
    fx.recorded = [];
    logs.entries = [];
    logs.dropped = 0;
    let value;
    try {
      value = await cells[cells.length - 1]();
    } catch (error) {
      return {
        ok: false,
        phase: "cell",
        error: describeError(error, undefined),
        logs: snapshotLogs(),
      };
    }

    const outcome = {
      ok: true,
      effects: fx.recorded,
      logs: snapshotLogs(),
      results: [],
    };
    try {
      structuredClone(value);
      outcome.value = value;
      outcome.hasValue = true;
    } catch {
      // Unclonable success: omit the value, ship a rendering instead.
      outcome.hasValue = false;
      outcome.results.push({ text: inspect(value, 0) });
    }
    return outcome;
  }
}
`;
}
