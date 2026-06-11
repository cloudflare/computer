import { DurableObject } from "cloudflare:workers";
import {
  type IWorkspaceContainerAPI,
  withWorkspaceContainer,
} from "@cloudflare/workspace/backends/container";
import { type ContainerPoolConfigEnv, containerSleepAfterMs } from "./container-config";
import type { WarmPoolRuntime } from "./container-pool-manager";
import { ContainerWarmPool } from "./container-warm-pool";

const WORKSPACE_PORT = 8080;
const WORKSPACE_HEALTH_INTERVAL_MS = 250;

export interface WorkspacePoolEnv extends ContainerPoolConfigEnv {
  FUSE_MOUNT?: string;
  WorkspaceContainerHost: DurableObjectNamespace<WorkspaceContainerHost>;
}

export interface WorkspaceContainerHostHandle {
  getWorkspaceContainer(): IWorkspaceContainerAPI | Promise<IWorkspaceContainerAPI>;
  startWarmContainer(env: Record<string, string>, inactivityTimeoutMs: number): Promise<void>;
  destroyWarmContainer(): Promise<void>;
  isWarmContainerHealthy(): Promise<boolean>;
}

export class WorkspaceWarmPool extends ContainerWarmPool<WorkspacePoolEnv> {
  protected createRuntime(env: WorkspacePoolEnv): WarmPoolRuntime {
    return createWorkspaceWarmPoolRuntime(env);
  }
}

class WorkspaceContainerHostDurableObject extends DurableObject<WorkspacePoolEnv> {}

class WorkspaceContainerHostBase extends withWorkspaceContainer(
  WorkspaceContainerHostDurableObject,
) {}

export class WorkspaceContainerHost extends WorkspaceContainerHostBase {
  async startWarmContainer(
    env: Record<string, string>,
    inactivityTimeoutMs: number,
  ): Promise<void> {
    await startWorkspaceContainerAndWait(this.getContainer(), env, inactivityTimeoutMs);
  }

  async destroyWarmContainer(): Promise<void> {
    await this.getContainer().destroy();
  }

  async isWarmContainerHealthy(): Promise<boolean> {
    try {
      await waitForWorkspaceHealth(() => this.getContainer().getTcpPort(WORKSPACE_PORT), 1);
      return true;
    } catch {
      return false;
    }
  }

  private getContainer(): NonNullable<DurableObjectState["container"]> {
    const container = this.ctx.container;
    if (!container) {
      throw new Error("WorkspaceContainerHost is not container-enabled");
    }
    return container;
  }
}

export function createWorkspaceWarmPoolRuntime(env: WorkspacePoolEnv): WarmPoolRuntime {
  return {
    async startContainer(containerId) {
      const host = getWorkspaceContainerHost(env, containerId);
      try {
        await host.startWarmContainer(workspaceContainerEnv(env), containerSleepAfterMs(env));
      } catch (error) {
        console.warn({
          message: "Workspace warm container failed to start",
          component: "workspace-warm-pool",
          containerId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    async destroyContainer(containerId) {
      await getWorkspaceContainerHost(env, containerId).destroyWarmContainer();
    },
    async isContainerRunning(containerId) {
      return getWorkspaceContainerHost(env, containerId).isWarmContainerHealthy();
    },
    async keepContainerAlive(containerId) {
      if (!(await getWorkspaceContainerHost(env, containerId).isWarmContainerHealthy())) {
        throw new Error("Workspace warm container is not healthy");
      }
    },
  };
}

function getWorkspaceContainerHost(
  env: WorkspacePoolEnv,
  containerId: string,
): WorkspaceContainerHostHandle {
  return env.WorkspaceContainerHost.get(
    env.WorkspaceContainerHost.idFromName(containerId),
  ) as unknown as WorkspaceContainerHostHandle;
}

function workspaceContainerEnv(env: WorkspacePoolEnv): Record<string, string> {
  return {
    PORT: String(WORKSPACE_PORT),
    MOUNT_POINT: "/workspace",
    ...(env.FUSE_MOUNT ? { FUSE_MOUNT: env.FUSE_MOUNT } : {}),
  };
}

interface WorkspaceContainerControl {
  readonly running: boolean;
  setInactivityTimeout(durationMs: number): Promise<void>;
  start(options: { enableInternet: boolean; env: Record<string, string> }): void;
  getTcpPort(port: number): Fetcher;
}

interface WorkspaceStartWaitOptions {
  attempts?: number;
  wait?: (durationMs: number) => Promise<void>;
}

export async function startWorkspaceContainerAndWait(
  container: WorkspaceContainerControl,
  env: Record<string, string>,
  inactivityTimeoutMs: number,
  options: WorkspaceStartWaitOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 120;
  const wait = options.wait ?? ((durationMs) => scheduler.wait(durationMs));
  await container.setInactivityTimeout(inactivityTimeoutMs);

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!container.running) {
      container.start({ enableInternet: true, env });
    }
    try {
      await waitForWorkspaceHealth(() => container.getTcpPort(WORKSPACE_PORT), 1);
      return;
    } catch (error) {
      lastError = error;
    }
    await wait(WORKSPACE_HEALTH_INTERVAL_MS);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitForWorkspaceHealth(port: () => Fetcher, attempts = 120): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await port().fetch("http://container/health", { method: "HEAD" });
      void response.body?.cancel();
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await scheduler.wait(WORKSPACE_HEALTH_INTERVAL_MS);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
