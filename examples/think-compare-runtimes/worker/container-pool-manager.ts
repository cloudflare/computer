const STATE_KEY = "container-warm-pool";

export interface WarmPoolRuntime {
  startContainer(containerId: string): Promise<void>;
  destroyContainer(containerId: string): Promise<void>;
  isContainerRunning(containerId: string): Promise<boolean>;
  keepContainerAlive(containerId: string): Promise<void>;
}

interface WarmPoolStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

interface WarmPoolState {
  warm: string[];
  assignments: Record<string, string>;
  releasing: string[];
}

export interface ContainerWarmPoolManagerOptions {
  storage: WarmPoolStorage;
  runtime: WarmPoolRuntime;
  target: number;
  createContainerId?: () => string;
}

export class ContainerWarmPoolManager {
  readonly #storage: WarmPoolStorage;
  readonly #runtime: WarmPoolRuntime;
  readonly #target: number;
  readonly #createContainerId: () => string;
  #operationQueue: Promise<unknown> = Promise.resolve();

  constructor({
    storage,
    runtime,
    target,
    createContainerId = () => crypto.randomUUID(),
  }: ContainerWarmPoolManagerOptions) {
    this.#storage = storage;
    this.#runtime = runtime;
    this.#target = Math.max(0, target);
    this.#createContainerId = createContainerId;
  }

  getContainer(logicalId: string): Promise<string> {
    return this.#serialize(async () => {
      const state = await this.#load();
      const existing = state.assignments[logicalId];
      if (existing && (await this.#runtime.isContainerRunning(existing))) {
        return existing;
      }
      if (existing) {
        delete state.assignments[logicalId];
        markReleasing(state, existing);
      }

      const warm = state.warm.shift();
      let containerId: string;
      try {
        containerId = warm ?? (await this.#startNewContainer(state));
      } catch (error) {
        await this.#save(state);
        throw error;
      }
      state.assignments[logicalId] = containerId;
      await this.#save(state);
      return containerId;
    });
  }

  releaseContainer(logicalId: string): Promise<void> {
    return this.#serialize(async () => {
      const state = await this.#load();
      const containerId = state.assignments[logicalId];
      if (!containerId) return;

      delete state.assignments[logicalId];
      state.warm = state.warm.filter((id) => id !== containerId);
      markReleasing(state, containerId);
      await this.#drainReleasing(state);
      await this.#save(state);
    });
  }

  refresh(): Promise<void> {
    return this.#serialize(async () => {
      const state = await this.#load();
      await this.#drainReleasing(state);
      await this.#reconcileAssignments(state);
      await this.#reconcileWarmContainers(state);
      await this.#scaleWarmContainersDown(state);

      if (state.releasing.length === 0) {
        while (state.warm.length < this.#target) {
          try {
            state.warm.push(await this.#startNewContainer(state));
          } catch {
            break;
          }
        }
      }

      await this.#save(state);
    });
  }

  reset(): Promise<void> {
    return this.#serialize(async () => {
      const state = await this.#load();
      for (const containerId of [
        ...state.releasing,
        ...Object.values(state.assignments),
        ...state.warm,
      ]) {
        markReleasing(state, containerId);
      }
      state.assignments = {};
      state.warm = [];
      await this.#drainReleasing(state);
      await this.#save(state);
    });
  }

  snapshot(): Promise<WarmPoolState> {
    return this.#serialize(() => this.#load());
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue.then(operation, operation);
    this.#operationQueue = result.catch(() => {});
    return result;
  }

  async #reconcileAssignments(state: WarmPoolState): Promise<void> {
    for (const [logicalId, containerId] of Object.entries(state.assignments)) {
      if (await this.#runtime.isContainerRunning(containerId)) continue;
      delete state.assignments[logicalId];
      markReleasing(state, containerId);
    }
    await this.#drainReleasing(state);
  }

  async #reconcileWarmContainers(state: WarmPoolState): Promise<void> {
    const warm: string[] = [];
    for (const containerId of state.warm) {
      if (await this.#runtime.isContainerRunning(containerId)) {
        await this.#runtime.keepContainerAlive(containerId);
        warm.push(containerId);
      } else {
        markReleasing(state, containerId);
      }
    }
    state.warm = warm;
    await this.#drainReleasing(state);
  }

  async #scaleWarmContainersDown(state: WarmPoolState): Promise<void> {
    const excess = state.warm.splice(this.#target);
    for (const containerId of excess) {
      markReleasing(state, containerId);
    }
    await this.#drainReleasing(state);
  }

  async #drainReleasing(state: WarmPoolState): Promise<void> {
    const stillReleasing: string[] = [];
    for (const containerId of state.releasing) {
      try {
        await this.#runtime.destroyContainer(containerId);
      } catch {
        stillReleasing.push(containerId);
      }
    }
    state.releasing = unique(stillReleasing);
  }

  async #startNewContainer(state: WarmPoolState): Promise<string> {
    const containerId = this.#createContainerId();
    try {
      await this.#runtime.startContainer(containerId);
      return containerId;
    } catch (error) {
      markReleasing(state, containerId);
      await this.#drainReleasing(state);
      throw error;
    }
  }

  async #load(): Promise<WarmPoolState> {
    const stored = await this.#storage.get<Partial<WarmPoolState>>(STATE_KEY);
    return {
      warm: stored?.warm ?? [],
      assignments: stored?.assignments ?? {},
      releasing: stored?.releasing ?? [],
    };
  }

  async #save(state: WarmPoolState): Promise<void> {
    await this.#storage.put(STATE_KEY, {
      warm: unique(state.warm),
      assignments: state.assignments,
      releasing: unique(state.releasing),
    });
  }
}

function markReleasing(state: WarmPoolState, containerId: string): void {
  state.warm = state.warm.filter((id) => id !== containerId);
  if (!state.releasing.includes(containerId)) {
    state.releasing.push(containerId);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
