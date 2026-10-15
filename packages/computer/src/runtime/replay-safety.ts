import type { WorkspaceModuleFunction } from "./types.js";

const UNSAFE_TO_REPEAT = Symbol.for("cloudflare.workspace.module.unsafeToRepeat");

/**
 * Mark a host module function as unsafe to run twice.
 *
 * A replayable run interrupted while one of its calls was in flight runs
 * that call again when it resumes, since its response never reached the
 * code. That's fine for reads and idempotent writes. A function that
 * charges a card or sends a message once per call should be marked, so
 * an interruption during it fails the run instead. A function that can
 * deduplicate with `context.callId` doesn't need marking.
 *
 * ```ts
 * modules: {
 *   "ws:billing": { charge: unsafeToRepeat(async ([order, cents]) => ...) },
 * }
 * ```
 */
export function unsafeToRepeat<F extends WorkspaceModuleFunction>(fn: F): F {
  Object.defineProperty(fn, UNSAFE_TO_REPEAT, { value: true });
  return fn;
}

export function isUnsafeToRepeat(fn: unknown): boolean {
  return (
    typeof fn === "function" &&
    (fn as unknown as Record<symbol, unknown>)[UNSAFE_TO_REPEAT] === true
  );
}
