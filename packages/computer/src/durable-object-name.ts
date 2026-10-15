// Keeping a Durable Object's name across proxy wakes.
//
// The workspace proxies reach their host Durable Object from props
// that a container or a Dynamic Worker holds on to. Both outlive the
// object: after an eviction or a deploy, the proxy is often the first
// caller, and the instance it wakes is the one every later caller
// shares. An instance woken through idFromString() has no
// ctx.id.name for its whole lifetime, and anything that needs the
// name (agents' Lifecycle, for one) then refuses to start. So the
// props may carry the name too, and the proxy addresses the object
// by name whenever that name produces the same id.

// The part of DurableObjectNamespace the proxies use. Structural, so
// this module needs no runtime import.
interface DurableObjectIds<Id> {
  idFromName(name: string): Id;
  idFromString(id: string): Id;
}

/**
 * Resolve the id a proxy should wake its host Durable Object with.
 *
 * Prefers `idFromName(name)` when it yields `id`, so the woken
 * instance keeps `ctx.id.name`. A missing name, or one that maps to a
 * different object, falls back to `idFromString(id)`: `id` stays the
 * authority on which object is meant.
 */
export function hostDurableObjectId<Id extends { toString(): string }>(
  ns: DurableObjectIds<Id>,
  id: string,
  name: string | undefined,
): Id {
  if (name !== undefined && name !== "") {
    const named = ns.idFromName(name);
    if (named.toString() === id) return named;
  }
  return ns.idFromString(id);
}

/**
 * Fill in `name` on a reference to the Durable Object that owns `ctx`.
 *
 * Callers usually build the reference from `ctx.id.toString()` alone.
 * When the reference points at this very object and the runtime knows
 * its name, the name is added so the proxy can wake it by name later.
 * A reference to another object, or one that already names itself, is
 * returned unchanged.
 */
export function withHostName<Ref extends { id: string; name?: string }>(
  ref: Ref,
  ctx: unknown,
): Ref {
  if (ref.name !== undefined) return ref;
  const id = (ctx as { id?: { name?: string; toString(): string } } | undefined)?.id;
  const name = id?.name;
  if (name === undefined || name === "" || id?.toString() !== ref.id) return ref;
  return { ...ref, name };
}
