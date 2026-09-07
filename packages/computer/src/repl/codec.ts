// Tagged JSON-safe value codec for the REPL session log.
//
// Capability args, capability results, and grant data snapshots are stored
// as JSON rows in the workspace SQLite, but cells traffic in real JS
// values. Plain JSON would silently mangle Dates to strings and drop
// undefined — and a value that replays differently from how it ran is log
// corruption. So values are encoded into a tagged JSON-safe form on the
// way in and decoded back on the way out; anything the codec can't
// round-trip exactly is rejected loudly with the fix named.
//
// Both functions are deliberately self-contained (no imports, no module
// scope): the host imports them, and the isolate-side runner injects their
// source via Function.prototype.toString(). One definition, two runtimes.
//
// Encoding: JSON-native values pass through; everything else becomes a
// `{ $repl: tag, ... }` object. Plain objects that happen to contain a
// `$repl` key are escaped as `{ $repl: "obj", v }`. The hooks let the
// recorder swap live capability handles for `{ $repl: "handle", id }`
// markers (encode) and revive markers back into proxies or registry
// objects (decode) — the codec itself treats markers as opaque protocol
// data and carries them through unchanged.

/**
 * Encode a value into the tagged JSON-safe form.
 *
 * `replaceSpecial` may return a replacement (already JSON-safe — used for
 * handle markers) or `undefined` to fall through to normal encoding.
 * Throws on values that cannot round-trip (functions, class instances,
 * cycles, …).
 */
export function encodeReplValue(
  value: unknown,
  replaceSpecial?: (candidate: unknown) => unknown,
): unknown {
  const seen = new WeakSet<object>();
  const reject = (what: string): never => {
    throw new Error(
      `A ${what} cannot be recorded in the session log. Values crossing a ` +
        "capability call must be plain data: objects, arrays, strings, " +
        "numbers, booleans, null, undefined, bigint, Date, Uint8Array, " +
        "ArrayBuffer, Map, or Set. Keep other values in session variables — " +
        "only what crosses the capability boundary is recorded.",
    );
  };
  const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 4096) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
    }
    return btoa(binary);
  };
  const walk = (input: unknown): unknown => {
    if (replaceSpecial) {
      const replaced = replaceSpecial(input);
      if (replaced !== undefined) return replaced;
    }
    if (input === null || typeof input === "boolean" || typeof input === "string") return input;
    if (typeof input === "number") {
      if (Number.isFinite(input) && !Object.is(input, -0)) return input;
      return { $repl: "num", v: String(input) };
    }
    if (input === undefined) return { $repl: "undefined" };
    if (typeof input === "bigint") return { $repl: "bigint", v: String(input) };
    if (typeof input === "function") return reject("function");
    if (typeof input === "symbol") return reject("symbol");
    if (typeof input !== "object") return reject(typeof input);

    if (input instanceof Date) {
      const ms = input.getTime();
      return { $repl: "date", v: Number.isNaN(ms) ? null : ms };
    }
    if (input instanceof Uint8Array) return { $repl: "u8", v: bytesToBase64(input) };
    if (input instanceof ArrayBuffer) {
      return { $repl: "ab", v: bytesToBase64(new Uint8Array(input)) };
    }
    if (ArrayBuffer.isView(input)) return reject(`${input.constructor.name} (use Uint8Array)`);

    if (seen.has(input)) {
      throw new Error(
        "A value with a reference cycle cannot be recorded in the session " +
          "log. Flatten it before returning it across a capability call.",
      );
    }
    seen.add(input);
    try {
      if (input instanceof Map) {
        const entries: unknown[] = [];
        for (const [key, entry] of input) entries.push([walk(key), walk(entry)]);
        return { $repl: "map", v: entries };
      }
      if (input instanceof Set) {
        const items: unknown[] = [];
        for (const item of input) items.push(walk(item));
        return { $repl: "set", v: items };
      }
      if (Array.isArray(input)) {
        const items: unknown[] = [];
        for (let i = 0; i < input.length; i++) items.push(walk(input[i]));
        return items;
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        const name =
          (input as { constructor?: { name?: string } }).constructor?.name ?? "class instance";
        return reject(`${name} instance`);
      }
      const record = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record)) out[key] = walk(record[key]);
      if ("$repl" in out) return { $repl: "obj", v: out };
      return out;
    } finally {
      seen.delete(input);
    }
  };
  return walk(value);
}

/**
 * Decode a value from the tagged JSON-safe form.
 *
 * `reviveSpecial` may claim a tagged object (used to revive
 * `{ $repl: "handle", id }` markers into live proxies) by returning a
 * non-undefined value. Unclaimed handle markers pass through unchanged;
 * any other unknown tag throws — an unreadable log entry is corruption
 * and must be loud.
 */
export function decodeReplValue(
  encoded: unknown,
  reviveSpecial?: (tagged: { $repl: string } & Record<string, unknown>) => unknown,
): unknown {
  const base64ToBytes = (text: string): Uint8Array => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  const walk = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map((item) => walk(item));
    const record = input as Record<string, unknown>;
    const tag = record.$repl;
    if (typeof tag !== "string") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record)) out[key] = walk(record[key]);
      return out;
    }
    if (reviveSpecial) {
      const revived = reviveSpecial(record as { $repl: string } & Record<string, unknown>);
      if (revived !== undefined) return revived;
    }
    switch (tag) {
      case "undefined":
        return undefined;
      case "num":
        return record.v === "-0" ? -0 : Number(record.v);
      case "bigint":
        return BigInt(record.v as string);
      case "date":
        return new Date(record.v === null ? Number.NaN : (record.v as number));
      case "u8":
        return base64ToBytes(record.v as string);
      case "ab": {
        const bytes = base64ToBytes(record.v as string);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      case "map": {
        const map = new Map<unknown, unknown>();
        for (const pair of record.v as [unknown, unknown][]) {
          map.set(walk(pair[0]), walk(pair[1]));
        }
        return map;
      }
      case "set": {
        const set = new Set<unknown>();
        for (const item of record.v as unknown[]) set.add(walk(item));
        return set;
      }
      case "obj": {
        // Escaped plain object: decode its values, but never re-interpret
        // the container itself as tagged — its $repl key is user data.
        const inner = record.v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(inner)) out[key] = walk(inner[key]);
        return out;
      }
      case "handle":
        // Unclaimed protocol marker: carry through for the layer above.
        return record;
      default:
        throw new Error(
          `Unknown tag ${JSON.stringify(tag)} in a recorded session value — ` +
            "the log entry is unreadable. This session's log no longer " +
            "matches this package version.",
        );
    }
  };
  return walk(encoded);
}
