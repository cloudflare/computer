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

import { decodeReplValue, encodeReplValue } from "./codec.js";

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
// emit() is load-bearing output (unlike logs), so past the per-cell entry
// cap it throws instead of dropping — deterministic across replay, and the
// error names the fix. The value ceiling is display transport, not replay
// input, so oversized values degrade to their rendering (omit-plus-render).
const MAX_EMIT_ENTRIES = 1_000;
const MAX_EMIT_VALUE_BYTES = 262_144;

// The runner source. A template-built string (matching how the
// worker-javascript backend ships its runtime module) so the package build
// needs no extra bundling step for isolate-side code. The value codec is
// injected from its host-side definition via Function.prototype.toString()
// — one codec, both runtimes.
export function replRunnerModule(): string {
  const codecSource = `${encodeReplValue.toString()}\n${decodeReplValue.toString()}`;
  return `
import { WorkerEntrypoint } from "cloudflare:workers";
import cells from "./${REPL_CELLS_MODULE}";

// Bundler-safety prelude. When the package consumer bundles with esbuild's
// keepNames option (wrangler's default), the codec sources injected below
// via Function.prototype.toString() arrive laced with __name(...) helper
// calls whose definition lives in the consumer bundle, not in this isolate.
// Define the same helper here so injected sources run either way. This
// module itself is a template string, so bundlers never transform it.
const __name = (target, value) =>
  Object.defineProperty(target, "name", { value, configurable: true });

${codecSource}

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

// --- capability proxies -------------------------------------------------
//
// Granted capabilities appear as globals. Every method call crosses the
// bridge in record mode and is logged (value, minted handle, or error —
// errors too, so a cell that caught one replays identically). In serve
// mode the log answers everything: zero live calls. Call identity is
// id + path + encoded args; any mismatch is a hard divergence error.

let BRIDGE;
const PROXY_META = new WeakMap();
const INJECTED = new Map();
// Grant shapes injected for the cell currently running — help() reads them.
let CURRENT_SHAPES = null;

function joinPath(path, prop) {
  return path === "" ? prop : path + "." + prop;
}

function makeCap(id, shape, recipe, path) {
  const base = shape && shape.callable ? function () {} : {};
  const proxy = new Proxy(base, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      // Never look like a thenable: \`await cap\` must yield the proxy.
      if (prop === "then") return undefined;
      if (shape && !shape.opaque) {
        if (shape.data && Object.prototype.hasOwnProperty.call(shape.data, prop)) {
          return decodeReplValue(shape.data[prop]);
        }
        if (shape.children && Object.prototype.hasOwnProperty.call(shape.children, prop)) {
          return makeCap(id, shape.children[prop], recipe, joinPath(path, prop));
        }
        if (shape.methods && shape.methods.includes(prop)) {
          return (...args) => doCall(id, joinPath(path, prop), args, recipe);
        }
        return undefined;
      }
      // Opaque surface (RPC stub): assume every property is a method.
      return (...args) => doCall(id, joinPath(path, prop), args, recipe);
    },
    apply(_target, _thisArg, args) {
      return doCall(id, path, args, recipe);
    },
  });
  PROXY_META.set(proxy, { id, recipe });
  return proxy;
}

function capError(e) {
  const error = new Error(e.message);
  error.name = e.name;
  if (e.kind) error.replKind = e.kind;
  return error;
}

async function doCall(id, path, args, recipe) {
  // Arg encoding failures are deterministic (same code, same throw), so
  // they need no effect entry — replay reproduces them from code alone.
  const encArgs = encodeReplValue(args, (candidate) => {
    const meta = PROXY_META.get(candidate);
    if (meta) return { $repl: "handle", id: meta.id, recipe: meta.recipe };
    return undefined;
  });
  const callId = id + "|" + (path === "" ? "()" : path) + "|" + JSON.stringify(encArgs);
  if (fx.mode === "record") {
    const reply = await BRIDGE.invoke(id, path, encArgs, recipe);
    if (!reply.ok) {
      fx.recorded.push({ kind: "cap", value: { call: callId, r: { t: "e", e: reply.error } } });
      throw capError(reply.error);
    }
    if (reply.handle) {
      fx.recorded.push({ kind: "cap", value: { call: callId, r: { t: "h", h: reply.handle } } });
      return makeCap(reply.handle.id, reply.handle.shape, reply.handle.recipe, "");
    }
    fx.recorded.push({ kind: "cap", value: { call: callId, r: { t: "v", v: reply.value } } });
    return decodeReplValue(reply.value);
  }
  const entry = fx.queue.shift();
  if (!entry || entry.kind !== "cap" || !entry.value || entry.value.call !== callId) {
    const found = !entry
      ? "nothing"
      : entry.kind !== "cap"
        ? "a " + JSON.stringify(entry.kind) + " effect"
        : "a different call (" + entry.value.call + ")";
    throw new Error(
      DIVERGENCE + "expected the recorded capability call " + callId + ", log had " + found +
      ". Committed cells must replay exactly; this session's log no longer matches its code."
    );
  }
  const r = entry.value.r;
  if (r.t === "e") throw capError(r.e);
  if (r.t === "h") return makeCap(r.h.id, r.h.shape, r.h.recipe, "");
  return decodeReplValue(r.v);
}

// (Re)inject capability globals for one cell. Replayed cells get the grant
// shapes they were recorded under — including their data snapshots — and
// the new cell gets the current attachment's. Injection happens at every
// cell start in both modes, so grants win over leftover same-name bindings
// identically live and on replay.
function injectGrants(shapes) {
  CURRENT_SHAPES = shapes || null;
  // Restore whatever a grant name shadowed (e.g. the ambient-fetch error
  // when a capability was granted as \`fetch\`), then remove our proxies.
  for (const [name, prior] of INJECTED) {
    try {
      if (prior) Object.defineProperty(globalThis, name, prior);
      else delete globalThis[name];
    } catch {}
  }
  INJECTED.clear();
  if (!shapes) return;
  for (const name of Object.keys(shapes)) {
    INJECTED.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    globalThis[name] = makeCap(name, shapes[name], name, "");
  }
}

// --- recorded nondeterminism shims ---------------------------------------

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

// Ambient network is deny-by-default (globalOutbound is null); replace
// fetch so the failure names the fix instead of a connection error.
if (typeof globalThis.fetch === "function") {
  globalThis.fetch = () => {
    throw new Error(
      "No ambient network in REPL sessions — egress is deny-by-default. " +
      "Network access arrives only as a granted fetch capability: call that " +
      "by its granted name, or ask the host to grant one (fetchCapability())."
    );
  };
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
  const capMeta = PROXY_META.get(value);
  if (capMeta) return "[capability handle: " + capMeta.recipe + "]";
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

// --- in-session built-ins: help() and emit() ------------------------------
//
// Neither is a capability and neither is ever recorded. help() is a pure
// function of the cell's injected grant shapes — replayed cells see the
// snapshot they were recorded under, so a committed help() call reproduces
// exactly even after grants change. emit() fills a per-cell display buffer;
// replayed cells' emits are discarded like their console output, so only
// the new cell's emits ride back on the result.

const emits = { entries: [] };

function emitValue(value) {
  if (emits.entries.length >= ${MAX_EMIT_ENTRIES}) {
    throw new Error(
      "emit(): this cell already emitted ${MAX_EMIT_ENTRIES} results. " +
      "Emit fewer, larger entries — or write bulk data to a workspace file " +
      "via a granted capability and emit the path."
    );
  }
  let text = inspect(value, 0);
  if (text.length > ${MAX_LOG_ENTRY_CHARS}) text = text.slice(0, ${MAX_LOG_ENTRY_CHARS}) + "…";
  const entry = { text };
  attachEmitValue(entry, value);
  emits.entries.push(entry);
  return value;
}

// Attach the structured value when it can cross the boundary and fits the
// per-entry ceiling; otherwise the rendering alone ships. Cloned at emit
// time, so later cell code can't mutate what was already published.
function attachEmitValue(entry, value) {
  if (PROXY_META.has(value)) return; // capability handles are not values
  let clone;
  try {
    clone = structuredClone(value);
  } catch {
    return; // unclonable: rendering only
  }
  try {
    const estimate = JSON.stringify(value);
    if (estimate !== undefined && estimate.length > ${MAX_EMIT_VALUE_BYTES}) {
      entry.text += " (structured value omitted: about " + estimate.length +
        " bytes exceeds the ${MAX_EMIT_VALUE_BYTES}-byte emit ceiling — " +
        "write large data to a workspace file and emit the path)";
      return;
    }
  } catch {
    // Clonable but not JSON-estimable (bigint, cycles): ship it.
  }
  entry.value = clone;
}

function helpText(name) {
  const shapes = CURRENT_SHAPES || {};
  const names = Object.keys(shapes);
  if (name === undefined) {
    const lines = [
      "Persistent JavaScript session: top-level await works, and bindings survive across cells — including restarts.",
      "Built-ins:",
      "  help(\\"name\\") — full docs for one granted capability",
      "  emit(value) — publish an extra structured result alongside the cell value (returns the value)",
    ];
    if (names.length === 0) {
      lines.push("No capabilities are granted in this session — pure JavaScript with durable state.");
    } else {
      lines.push("Capabilities:");
      for (const n of names) {
        const d = shapes[n] && shapes[n].description;
        lines.push("  " + n + (d ? " — " + d : ""));
      }
      lines.push("help(\\"name\\") shows a capability's methods and docs.");
    }
    return lines.join("\\n");
  }
  const key = String(name);
  if (!Object.prototype.hasOwnProperty.call(shapes, key)) {
    return "No capability named " + JSON.stringify(key) + " in this session." +
      (names.length > 0 ? " Granted: " + names.join(", ") + "." : " No capabilities are granted.") +
      " help() lists everything.";
  }
  const shape = shapes[key];
  const lines = [key + (shape.description ? " — " + shape.description : "")];
  renderShapeHelp(lines, key, "", shape, shape.docs || {});
  return lines.join("\\n");
}

// Walk a grant shape: methods (with grantor docs, dotted keys for nested
// surfaces), data snapshots with their current values, and children.
function renderShapeHelp(lines, path, docPath, shape, docs) {
  if (shape.opaque) {
    lines.push("  " + path + ".<method>(…) — surface unknown (opaque remote stub): call any method it supports");
    return;
  }
  if (shape.callable) {
    lines.push("  " + path + "(…) — callable directly" + (docs[docPath] ? ": " + docs[docPath] : ""));
  }
  for (const m of shape.methods || []) {
    const dk = docPath === "" ? m : docPath + "." + m;
    lines.push("  " + path + "." + m + "(…)" + (docs[dk] ? " — " + docs[dk] : ""));
  }
  for (const k of Object.keys(shape.data || {})) {
    let rendered;
    try { rendered = inspect(decodeReplValue(shape.data[k]), 1); } catch { rendered = "…"; }
    if (rendered.length > 200) rendered = rendered.slice(0, 200) + "…";
    lines.push("  " + path + "." + k + " = " + rendered);
  }
  for (const c of Object.keys(shape.children || {})) {
    renderShapeHelp(lines, path + "." + c, docPath === "" ? c : docPath + "." + c, shape.children[c], docs);
  }
}

globalThis.help = helpText;
globalThis.emit = emitValue;

function describeError(error, kind) {
  const isError = error instanceof Error;
  return {
    name: isError ? error.name : "Error",
    message: String(isError ? error.message : error),
    traceback: isError && error.stack ? String(error.stack) : undefined,
    // Bridge-classified failures (stale-lease, not-granted, …) carry their
    // kind on the thrown error; pass it through to the result.
    kind: kind ?? (isError && error.replKind ? error.replKind : undefined),
  };
}

export default class ReplRunner extends WorkerEntrypoint {
  // Replay every committed cell against its recorded effects, then run the
  // final cell in record mode. Returns a structured outcome; never throws
  // for cell-level failures (structure survives the RPC boundary, thrown
  // errors don't).
  async run(effectLog, bridge, grants) {
    BRIDGE = bridge;
    const perCell = (grants && grants.perCell) || [];
    const current = (grants && grants.current) || {};
    for (let i = 0; i < cells.length - 1; i++) {
      fx.mode = "serve";
      fx.queue = (effectLog[i] || []).slice();
      emits.entries = [];
      injectGrants(perCell[i]);
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
    emits.entries = [];
    injectGrants(current);
    let value;
    try {
      value = await cells[cells.length - 1]();
    } catch (error) {
      return {
        ok: false,
        phase: "cell",
        error: describeError(error, undefined),
        logs: snapshotLogs(),
        // A failing cell's emits still ship (they narrate the failure);
        // the cell itself is never committed.
        results: emits.entries.slice(),
      };
    }

    const outcome = {
      ok: true,
      effects: fx.recorded,
      logs: snapshotLogs(),
      // Emitted entries first; an unclonable completion value's rendering
      // appends after them (Jupyter display order).
      results: emits.entries.slice(),
    };
    try {
      // A capability handle is not a value — it structured-clones as an
      // empty shell — so it ships as a rendering instead.
      if (PROXY_META.has(value)) throw new Error("capability handle");
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
