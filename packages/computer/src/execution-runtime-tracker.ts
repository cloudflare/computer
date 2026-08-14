// Bounded runtime ownership cache for process-local execution ids.
// Returned execution handles carry their runtime id directly; this cache
// supports the public by-id lifecycle methods without growing for the
// entire lifetime of a busy Durable Object.

const DEFAULT_MAX_ENTRIES = 1_024;

export class ExecutionRuntimeTracker {
  readonly #entries = new Map<string, string>();
  readonly #maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("ExecutionRuntimeTracker maxEntries must be a positive integer");
    }
    this.#maxEntries = maxEntries;
  }

  get(key: string): string | undefined {
    const runtimeId = this.#entries.get(key);
    if (runtimeId === undefined) return undefined;
    // Map iteration order is insertion order. Reinsert reads so the
    // first key remains the least recently used one.
    this.#entries.delete(key);
    this.#entries.set(key, runtimeId);
    return runtimeId;
  }

  remember(key: string, runtimeId: string): void {
    this.#entries.delete(key);
    this.#entries.set(key, runtimeId);
    if (this.#entries.size <= this.#maxEntries) return;
    const oldest = this.#entries.keys().next().value;
    if (oldest !== undefined) this.#entries.delete(oldest);
  }

  delete(key: string, expectedRuntimeId?: string): void {
    if (expectedRuntimeId !== undefined && this.#entries.get(key) !== expectedRuntimeId) return;
    this.#entries.delete(key);
  }
}
