// Duplicated verbatim from ../container-legacy/. The two backends serve
// different container scheduling policies, but this file touches
// neither the launch spec nor the policy, so there is no divergence
// pressure on it and the copy is deliberate rather than overlooked.
// Fixes here apply to both copies.
//
// Durable identity for the currently-running container process.
//
// A WebSocket reconnect keeps this id. Starting a replacement process
// writes a new UUID. Execution-scoped operations use it to distinguish
// reconnecting to the same computerd from reaching an empty replacement.

export interface ContainerRuntimeIdentity {
  id: string;
}

interface RuntimeIdentityStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const STORAGE_KEY = "computer:container-runtime-identity";

export class CurrentContainerRuntimeIdentity {
  constructor(private readonly storage: RuntimeIdentityStorage) {}

  async get(): Promise<ContainerRuntimeIdentity | null> {
    return (await this.storage.get<ContainerRuntimeIdentity>(STORAGE_KEY)) ?? null;
  }

  async markStarted(): Promise<ContainerRuntimeIdentity> {
    const runtime = { id: crypto.randomUUID() };
    await this.storage.put(STORAGE_KEY, runtime);
    return runtime;
  }

  async clear(runtime: ContainerRuntimeIdentity): Promise<void> {
    const current = await this.get();
    if (current?.id === runtime.id) await this.storage.delete(STORAGE_KEY);
  }
}
