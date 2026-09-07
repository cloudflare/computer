// Capability grants for REPL sessions.
//
// One injection idiom: `capability(target, meta?)` wraps any object, class
// instance, RPC stub, or bare function; the session sees it as a global
// named by its grant key. Method calls cross the recorder bridge and are
// logged as effects; plain data on the target is snapshotted per cell so
// replay sees the values a cell originally ran with. `fetchCapability()`
// and `workspaceFs()` are ordinary capabilities built on the same wrapper —
// nothing about them is special-cased downstream.

import { WorkspaceRuntimeCapability } from "../runtime/capability.js";
import type { WorkspaceRuntimeAccess, WorkspaceRuntimeFilesystem } from "../runtime/types.js";
import { encodeReplValue } from "./codec.js";

const CAPABILITY_BRAND = Symbol.for("cloudflare.computer.replCapability");

/** Method-name keys of T — the only keys `docs` may use. */
export type MethodKeys<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T] &
  string;

export interface CapabilityMeta<T> {
  /** One-line summary, surfaced to the model in tool text and help(). */
  description?: string;
  /** Per-method docs; keys must name real methods of the target. */
  docs?: Partial<Record<MethodKeys<T>, string>>;
}

/** A granted capability: the live target plus its model-facing metadata. */
export interface ReplCapability<T = unknown> {
  readonly target: T;
  readonly meta: CapabilityMeta<T>;
}

/**
 * Wrap a target for granting to a REPL session.
 *
 * The target can be a plain object, a class instance, a Durable Object or
 * service binding stub, or a bare function (granted as a callable). Only
 * what the session actually calls is recorded — wrapping is free.
 */
export function capability<T extends object>(
  target: T,
  meta: CapabilityMeta<T> = {},
): ReplCapability<T> {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) {
    throw new TypeError("capability() needs an object or function target.");
  }
  return Object.freeze({
    [CAPABILITY_BRAND]: true,
    target,
    meta,
  }) as ReplCapability<T>;
}

export function isReplCapability(value: unknown): value is ReplCapability {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[CAPABILITY_BRAND] === true
  );
}

// ---------------------------------------------------------------------------
// Target shapes
//
// The isolate never holds real targets — it builds proxies from a shape:
// which keys are methods, which are data (encoded values, snapshotted per
// cell), and which are nested objects with their own surface. Stubs whose
// surface can't be reflected (RPC proxies) are `opaque`: every property
// access is treated as a method.

export interface ReplCapabilityShape {
  /** The target itself is invocable (bare-function grants, returned functions). */
  callable?: true;
  /** Unreflectable surface (RPC stub): every property is assumed callable. */
  opaque?: true;
  methods: string[];
  /** Encoded plain-data properties (the per-cell snapshot surface). */
  data: Record<string, unknown>;
  /** Nested objects that themselves have callable surface. */
  children: Record<string, ReplCapabilityShape>;
  description?: string;
  docs?: Record<string, string>;
}

const MAX_SHAPE_DEPTH = 3;

/**
 * Reflect a target into its shape. Throws when grant data can't be
 * recorded (the grant would break replay, so it must fail at attach).
 */
export function describeCapabilityTarget(target: unknown, depth = 0): ReplCapabilityShape {
  const shape: ReplCapabilityShape = { methods: [], data: {}, children: {} };
  if (typeof target === "function") shape.callable = true;
  if (target === null || (typeof target !== "object" && typeof target !== "function")) {
    throw new TypeError("Capability targets must be objects or functions.");
  }

  const record = target as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (typeof value === "function") {
      shape.methods.push(key);
    } else if (hasCallableSurface(value)) {
      if (depth >= MAX_SHAPE_DEPTH) {
        throw new Error(
          `Capability data nests callable objects deeper than ${MAX_SHAPE_DEPTH} ` +
            `levels (at ${JSON.stringify(key)}). Flatten the target.`,
        );
      }
      shape.children[key] = describeCapabilityTarget(value, depth + 1);
    } else {
      shape.data[key] = encodeReplValue(value);
    }
  }

  // Class instances keep their methods on the prototype chain.
  let prototype = Object.getPrototypeOf(target) as object | null;
  while (
    prototype !== null &&
    prototype !== Object.prototype &&
    prototype !== Function.prototype
  ) {
    for (const key of Object.getOwnPropertyNames(prototype)) {
      if (key === "constructor" || shape.methods.includes(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (typeof descriptor?.value === "function") shape.methods.push(key);
    }
    prototype = Object.getPrototypeOf(prototype);
  }

  // Nothing reflectable at all on a non-plain object: an RPC stub (DO
  // namespace stubs, service bindings) whose properties materialize on
  // access. Treat every property as a method and let the live call decide.
  if (
    !shape.callable &&
    shape.methods.length === 0 &&
    Object.keys(shape.data).length === 0 &&
    Object.keys(shape.children).length === 0 &&
    Object.getPrototypeOf(target) !== Object.prototype
  ) {
    shape.opaque = true;
  }

  return shape;
}

/** True when a value belongs on the callable surface rather than in data. */
export function hasCallableSurface(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (value === null || typeof value !== "object") return false;
  // Encodable exotics are data, never callables.
  if (
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  ) {
    return false;
  }
  if (Array.isArray(value)) return value.some((item) => hasCallableSurface(item));
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return true;
  return Object.values(value).some((item) => hasCallableSurface(item));
}

// ---------------------------------------------------------------------------
// fetchCapability — the one fetch factory. Outbound network access exists
// only when this grant is present; its absence is the deny-by-default.

export interface ReplFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface ReplFetchResponse {
  status: number;
  ok: boolean;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  /** Response body as text (captured once; callable any number of times). */
  text(): string;
  /** Response body parsed as JSON. */
  json(): unknown;
}

type FetcherLike = { fetch(input: string, init?: RequestInit): Promise<Response> };

/**
 * Build a fetch capability.
 *
 * - `fetchCapability()` — inherit the host worker's network access.
 * - `fetchCapability(fetcher)` — route through a gateway / service binding.
 * - `fetchCapability({ allow: [...] })` — hostname allowlist (exact match).
 *
 * The description is generated from the configuration, so the model's docs
 * can never drift from the actual egress policy.
 */
export function fetchCapability(
  config?: FetcherLike | { allow: readonly string[] },
): ReplCapability<(url: string, init?: ReplFetchInit) => Promise<ReplFetchResponse>> {
  // A fetcher always has a callable `fetch`; an allowlist config never
  // does. Probe the function first — it's the unambiguous signal.
  const fetcher =
    config && typeof (config as FetcherLike).fetch === "function"
      ? (config as FetcherLike)
      : undefined;
  const allow =
    !fetcher && config && Array.isArray((config as { allow: unknown }).allow)
      ? [...(config as { allow: readonly string[] }).allow]
      : undefined;

  const doFetch = async (url: string, init?: ReplFetchInit): Promise<ReplFetchResponse> => {
    if (allow !== undefined) {
      const host = new URL(url).hostname;
      if (!allow.includes(host)) {
        const error = new Error(
          `fetch to ${JSON.stringify(host)} is not allowed by this capability ` +
            `(allowed hosts: ${allow.join(", ") || "(none)"}). Ask your harness ` +
            "to widen the allowlist if this host is needed.",
        );
        error.name = "EgressDeniedError";
        throw error;
      }
    }
    const transport = fetcher ?? (globalThis as unknown as FetcherLike);
    const requestInit: RequestInit = {};
    if (init?.method !== undefined) requestInit.method = init.method;
    if (init?.headers !== undefined) requestInit.headers = init.headers;
    if (init?.body !== undefined) requestInit.body = init.body as BodyInit;
    const response = await transport.fetch(url, requestInit);
    // Capture the body once — the returned handle's text()/json() replay
    // from this capture, so they are repeatable and deterministic.
    const bodyText = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: response.status,
      ok: response.ok,
      statusText: response.statusText,
      url: response.url,
      headers,
      text: () => bodyText,
      json: () => JSON.parse(bodyText) as unknown,
    };
  };

  const description =
    allow !== undefined
      ? `HTTP fetch restricted to: ${allow.join(", ") || "(no hosts)"}`
      : fetcher
        ? "HTTP fetch routed through a host-provided gateway"
        : "HTTP fetch with the host worker's network access";

  return capability(doFetch, { description });
}

// ---------------------------------------------------------------------------
// workspaceFs — the workspace filesystem as an ordinary capability. Reads
// and writes are recorded effects: replay serves recorded results and never
// re-fires writes.

export interface WorkspaceFsOptions {
  /** Confine the capability under this absolute root (default "/"). */
  root?: string;
  access?: WorkspaceRuntimeAccess;
}

export function workspaceFs(
  workspace: { fs: WorkspaceRuntimeFilesystem },
  options: WorkspaceFsOptions = {},
): ReplCapability<{
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  readdir(path?: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  stat(path: string): Promise<{ size: number; mtime: number; isFile: boolean; isDirectory: boolean }>;
}> {
  const root = options.root ?? "/";
  const access = options.access ?? "read-write";
  const confined = new WorkspaceRuntimeCapability(workspace.fs, root, access);
  return capability(
    {
      readFile: (path: string) => confined.readFile(path),
      readFileBytes: (path: string) => confined.readFileBytes(path),
      writeFile: (path: string, content: string | Uint8Array) =>
        confined.writeFile(path, content),
      readdir: (path = ".") => confined.readdir(path),
      exists: (path: string) => confined.exists(path),
      mkdir: (path: string) => confined.mkdir(path, { recursive: true }),
      rm: (path: string, rmOptions?: { recursive?: boolean; force?: boolean }) =>
        confined.rm(path, rmOptions),
      stat: async (path: string) => {
        const stat = await confined.stat(path);
        return {
          size: stat.size,
          mtime: stat.mtime,
          isFile: stat.isFile,
          isDirectory: stat.isDirectory,
        };
      },
    },
    {
      description: `Workspace filesystem (root ${root}, ${access})`,
      docs: {
        readFile: "readFile(path) → string",
        readFileBytes: "readFileBytes(path) → Uint8Array",
        writeFile: "writeFile(path, content) — content is a string or Uint8Array",
        readdir: "readdir(path?) → string[] of entry names",
        exists: "exists(path) → boolean",
        mkdir: "mkdir(path) — recursive",
        rm: "rm(path, { recursive?, force? })",
        stat: "stat(path) → { size, mtime, isFile, isDirectory }",
      },
    },
  );
}
