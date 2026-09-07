// Host-side capability bridge for REPL sessions.
//
// One bridge per session host. Root grants are swapped wholesale by
// attach(); the registry of handles the session has acquired from them
// (tabs, response objects, …) lives as long as the session host does.
// Every handle remembers which root granted it, so revoking a root also
// cuts every handle derived from it. The isolate never holds a real
// target — it calls `invoke(id, path, args, recipe)` across native
// Workers RPC, and the bridge resolves, calls, and classifies the outcome:
//
//   - plain data        → encoded value (recorded, replayable)
//   - object-with-methods / function → minted handle (id + shape + recipe)
//   - thrown error      → structured error reply (recorded, so a cell that
//                         caught it replays identically)
//
// `invoke` never throws: a thrown error would cross two RPC hops and lose
// its structure; a reply object survives verbatim.
//
// Handle ids are namespaced by a per-host epoch, so a handle recorded
// before a restart can never collide with a live one — a lookup miss is
// answered with the handle's acquisition recipe (stale lease), and a root
// miss with the attachment's actual grant list (not granted).

import { RpcTarget } from "cloudflare:workers";

import type { ReplCapability, ReplCapabilityShape } from "./capability.js";
import { describeCapabilityTarget, hasCallableSurface, isReplCapability } from "./capability.js";
import { decodeReplValue, encodeReplValue } from "./codec.js";

export interface ReplInvokeError {
  name: string;
  message: string;
  /** Protocol-level classification (stale-lease, not-granted, …). */
  kind?: string;
}

export interface ReplInvokeHandle {
  id: string;
  shape: ReplCapabilityShape;
  recipe: string;
}

export type ReplInvokeReply =
  | { ok: true; value: unknown }
  | { ok: true; handle: ReplInvokeHandle }
  | { ok: false; error: ReplInvokeError };

export interface ReplBridgeOptions {
  /** Per-effect recorded-value ceiling in JSON bytes (default 1 MiB). */
  maxEffectBytes?: number;
}

const DEFAULT_MAX_EFFECT_BYTES = 1024 * 1024;

/** Shorten an encoded-args array into a human recipe fragment. */
function argsPreview(args: unknown[]): string {
  const parts = args.map((arg) => {
    const text = JSON.stringify(arg) ?? "undefined";
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  });
  const joined = parts.join(", ");
  return joined.length > 120 ? `${joined.slice(0, 117)}…` : joined;
}

interface RegistryEntry {
  value: unknown;
  recipe: string;
  /** The root grant name this object descends from (itself, for roots). */
  root: string;
}

export class ReplCapabilityBridge extends RpcTarget {
  // Roots are replaced wholesale on attach(); handles persist for the
  // bridge's (= session host's) lifetime.
  #roots = new Map<string, RegistryEntry>();
  #handles = new Map<string, RegistryEntry>();
  #shapes: Record<string, ReplCapabilityShape> = {};
  #grantNames: string[] = [];
  #epoch: string;
  #next = 1;
  #maxEffectBytes: number;

  constructor(capabilities: Record<string, ReplCapability>, options: ReplBridgeOptions = {}) {
    super();
    this.#epoch = Math.random().toString(36).slice(2, 8);
    this.#maxEffectBytes = options.maxEffectBytes ?? DEFAULT_MAX_EFFECT_BYTES;
    this.attach(capabilities);
  }

  /** Replace the root grants. Handles survive — but only stay callable
   *  while the root they descend from remains granted. */
  attach(capabilities: Record<string, ReplCapability>): void {
    this.#roots.clear();
    this.#shapes = {};
    this.#grantNames = [];
    for (const [name, grant] of Object.entries(capabilities)) {
      if (!isReplCapability(grant)) {
        throw new TypeError(
          `Capability ${JSON.stringify(name)} must be created with capability(), ` +
            "fetchCapability(), or workspaceFs() — got a raw value.",
        );
      }
      // Shape reflection throws on unrecordable grant data — deliberately,
      // at attach time, where the host developer can see it.
      const shape = describeCapabilityTarget(grant.target);
      if (grant.meta.description !== undefined) shape.description = grant.meta.description;
      if (grant.meta.docs !== undefined) shape.docs = { ...grant.meta.docs } as Record<string, string>;
      this.#roots.set(name, { value: grant.target, recipe: name, root: name });
      this.#shapes[name] = shape;
      this.#grantNames.push(name);
    }
  }

  /** Current attachment's grant shapes (host-side; used for cell snapshots). */
  shapes(): Record<string, ReplCapabilityShape> {
    return this.#shapes;
  }

  // Resolve an id to a live, currently-granted object — or the structured
  // error that says exactly why not and what to do about it.
  #resolve(
    id: string,
    recipe: string,
  ): { ok: true; entry: RegistryEntry } | { ok: false; error: ReplInvokeError } {
    const entry = this.#roots.get(id) ?? this.#handles.get(id);
    if (!entry) {
      if (id.startsWith("~")) {
        return {
          ok: false,
          error: {
            name: "StaleLeaseError",
            kind: "stale-lease",
            message:
              "This handle is stale: the live object behind it died with a " +
              "session host restart. Committed cells still replay from the log. " +
              `To use it in new code, re-acquire it by re-running: ${recipe}`,
          },
        };
      }
      return {
        ok: false,
        error: {
          name: "NotGrantedError",
          kind: "not-granted",
          message:
            `"${id}" is not granted in this attachment. Granted here: ` +
            `${this.#grantNames.join(", ") || "(nothing)"}. Grants are attach-time — ` +
            "the host must re-attach the session with this capability before new " +
            "code can call it. (Committed cells replay from the log and are unaffected.)",
        },
      };
    }
    if (!this.#roots.has(entry.root)) {
      return {
        ok: false,
        error: {
          name: "NotGrantedError",
          kind: "not-granted",
          message:
            `This handle descends from "${entry.root}" (via ${entry.recipe}), ` +
            `which is not granted in this attachment. Granted here: ` +
            `${this.#grantNames.join(", ") || "(nothing)"}. Re-attach with ` +
            `"${entry.root}" to use it again.`,
        },
      };
    }
    return { ok: true, entry };
  }

  async invoke(id: string, path: string, args: unknown[], recipe: string): Promise<ReplInvokeReply> {
    const resolved = this.#resolve(id, recipe);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const entry = resolved.entry;

    // Revive handle markers in the args into live registry objects.
    let argError: ReplInvokeError | undefined;
    let decodedArgs: unknown[];
    try {
      decodedArgs = decodeReplValue(args, (tagged) => {
        if (tagged.$repl !== "handle") return undefined;
        const argRecipe = typeof tagged.recipe === "string" ? tagged.recipe : String(tagged.id);
        const argResolved = this.#resolve(String(tagged.id), argRecipe);
        if (!argResolved.ok) {
          argError = argResolved.error;
          throw new Error("unresolvable handle argument");
        }
        return argResolved.entry.value;
      }) as unknown[];
    } catch (error) {
      if (argError !== undefined) return { ok: false, error: argError };
      return {
        ok: false,
        error: {
          name: "TypeError",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    // Walk the path from the target and call.
    let parent: unknown = undefined;
    let fn: unknown = entry.value;
    if (path !== "") {
      for (const segment of path.split(".")) {
        parent = fn;
        fn = (fn as Record<string, unknown> | undefined)?.[segment];
      }
    }
    if (typeof fn !== "function") {
      return {
        ok: false,
        error: {
          name: "TypeError",
          message:
            `${entry.recipe}${path === "" ? "" : `.${path}`} is not a function ` +
            "on this capability.",
        },
      };
    }

    let result: unknown;
    try {
      result = await Reflect.apply(fn, parent, decodedArgs);
    } catch (error) {
      // A real capability error. Name and message only — host stack traces
      // don't belong inside the session.
      const name = error instanceof Error ? error.name : "Error";
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: { name, message } };
    }

    // Callable results become handles the session can keep using.
    if (hasCallableSurface(result)) {
      const handleId = `~${this.#epoch}-${this.#next++}`;
      const call = `${entry.recipe}${path === "" ? "" : `.${path}`}(${argsPreview(args)})`;
      let shape: ReplCapabilityShape;
      try {
        shape = describeCapabilityTarget(result);
      } catch (error) {
        return {
          ok: false,
          error: {
            name: "UnrecordableValueError",
            message:
              `The object returned by ${call} cannot be granted as a handle: ` +
              (error instanceof Error ? error.message : String(error)),
          },
        };
      }
      this.#handles.set(handleId, { value: result, recipe: call, root: entry.root });
      return { ok: true, handle: { id: handleId, shape, recipe: call } };
    }

    // Plain data: encode for the log, enforce the size ceiling.
    let encoded: unknown;
    try {
      encoded = encodeReplValue(result);
    } catch (error) {
      return {
        ok: false,
        error: {
          name: "UnrecordableValueError",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const bytes = JSON.stringify(encoded)?.length ?? 0;
    if (bytes > this.#maxEffectBytes) {
      return {
        ok: false,
        error: {
          name: "OversizedResultError",
          kind: "oversized-result",
          message:
            `This capability call returned ${bytes} bytes; the per-call recorded ` +
            `ceiling is ${this.#maxEffectBytes}. Results are recorded in the session ` +
            "log verbatim (never truncated). Write large data to workspace files " +
            "and return a path, or return a smaller slice.",
        },
      };
    }
    return { ok: true, value: encoded };
  }
}
