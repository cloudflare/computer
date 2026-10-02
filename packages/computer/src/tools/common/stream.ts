/**
 * Drain an executor to its settled result.
 *
 * A streaming executor yields successive complete snapshots of one run
 * rather than deltas, so the last one is the whole result.
 */
export async function settle<Output>(
  returned: Promise<Output> | AsyncIterable<Output>,
): Promise<Output> {
  if (isAsyncIterable<Output>(returned)) {
    let last: Output | undefined;
    let seen = false;
    for await (const chunk of returned) {
      last = chunk;
      seen = true;
    }
    if (!seen) throw new Error("tool executor yielded no result");
    return last as Output;
  }
  return await returned;
}

export function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in (value as Record<PropertyKey, unknown>)
  );
}
