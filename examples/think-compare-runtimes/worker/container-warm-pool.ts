import { DurableObject } from "cloudflare:workers";
import {
  type ContainerPoolConfigEnv,
  warmPoolRefreshIntervalMs,
  warmPoolTarget,
} from "./container-config";
import { ContainerWarmPoolManager, type WarmPoolRuntime } from "./container-pool-manager";

const POOL_NAME = "default";

export interface ContainerWarmPoolHandle {
  getContainer(logicalId: string): Promise<string>;
  releaseContainer(logicalId: string): Promise<void>;
  refresh(): Promise<void>;
  reset(): Promise<void>;
}

export type ContainerWarmPoolNamespace = DurableObjectNamespace;

export abstract class ContainerWarmPool<Env extends ContainerPoolConfigEnv>
  extends DurableObject<Env>
  implements ContainerWarmPoolHandle
{
  readonly #manager: ContainerWarmPoolManager;
  readonly #refreshIntervalMs: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#manager = new ContainerWarmPoolManager({
      storage: ctx.storage,
      runtime: this.createRuntime(env),
      target: warmPoolTarget(env),
    });
    this.#refreshIntervalMs = warmPoolRefreshIntervalMs(env);
    ctx.blockConcurrencyWhile(async () => {
      await this.#applyConfiguredReset();
      await this.#scheduleRefresh();
    });
  }

  protected abstract createRuntime(env: Env): WarmPoolRuntime;

  async getContainer(logicalId: string): Promise<string> {
    return this.#manager.getContainer(logicalId);
  }

  async releaseContainer(logicalId: string): Promise<void> {
    await this.#manager.releaseContainer(logicalId);
    this.ctx.waitUntil(this.#manager.refresh());
  }

  async refresh(): Promise<void> {
    await this.#applyConfiguredReset();
    await this.#manager.refresh();
    await this.#scheduleRefresh();
  }

  async reset(): Promise<void> {
    await this.#manager.reset();
  }

  async alarm(): Promise<void> {
    await this.refresh();
  }

  async #applyConfiguredReset(): Promise<void> {
    const resetKey = this.env.WARM_POOL_RESET_KEY;
    if (!resetKey) return;

    const appliedKey = await this.ctx.storage.get<string>("container-warm-pool-reset-key");
    if (appliedKey === resetKey) return;

    await this.#manager.reset();
    await this.ctx.storage.put("container-warm-pool-reset-key", resetKey);
  }

  async #scheduleRefresh(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + this.#refreshIntervalMs);
  }
}

export function getWarmPoolHandle(namespace: ContainerWarmPoolNamespace): ContainerWarmPoolHandle {
  return namespace.get(namespace.idFromName(POOL_NAME)) as unknown as ContainerWarmPoolHandle;
}
