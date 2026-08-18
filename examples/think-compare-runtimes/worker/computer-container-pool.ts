import { DurableObject } from "cloudflare:workers";
import {
  type ContainerLaunchSpec,
  type IWorkspaceContainerAPI,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
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
  startWarmContainer(spec: ContainerLaunchSpec, inactivityTimeoutMs: number): Promise<void>;
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
  async startWarmContainer(spec: ContainerLaunchSpec, inactivityTimeoutMs: number): Promise<void> {
    // Through the workspace API rather than ctx.container, so the launch
    // carries whatever the API adds — today the shared secret the
    // daemon's HTTP surface requires — and is recorded, so the workspace
    // that adopts this container can tell it matches.
    await startWorkspaceContainerAndWait(this.getWorkspaceContainer(), spec, inactivityTimeoutMs);
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
        await host.startWarmContainer(workspaceLaunchSpec(env), containerSleepAfterMs(env));
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

function workspaceLaunchSpec(env: WorkspacePoolEnv): ContainerLaunchSpec {
  return {
    env: {
      PORT: String(WORKSPACE_PORT),
      MOUNT_POINT: "/workspace",
      ...(env.FUSE_MOUNT ? { FUSE_MOUNT: env.FUSE_MOUNT } : {}),
    },
    // A pool cannot know the egress policy of the workspace that will
    // adopt a container, so this has to agree with it by configuration.
    // Disagreeing costs a relaunch on adoption, not the policy: the
    // adopting workspace compares this spec against its own and
    // replaces the container rather than inheriting the wrong one.
    enableInternet: true,
  };
}

// The subset of the workspace container API a warm start needs.
// Structurally satisfied by IWorkspaceContainerAPI.
interface WorkspaceWarmStartAPI {
  setInactivityTimeout(durationMs: number): Promise<void>;
  start(spec: ContainerLaunchSpec): Promise<unknown>;
  port(port: number): Fetcher;
}

interface WorkspaceStartWaitOptions {
  attempts?: number;
  wait?: (durationMs: number) => Promise<void>;
}

export async function startWorkspaceContainerAndWait(
  api: WorkspaceWarmStartAPI,
  spec: ContainerLaunchSpec,
  inactivityTimeoutMs: number,
  options: WorkspaceStartWaitOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 120;
  const wait = options.wait ?? ((durationMs) => scheduler.wait(durationMs));
  await api.setInactivityTimeout(inactivityTimeoutMs);

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Called unconditionally: start() adopts a container already running
    // with this spec, so there is no need to check `running` first the
    // way a raw ctx.container.start() did.
    await api.start(spec);
    try {
      await waitForWorkspaceHealth(() => api.port(WORKSPACE_PORT), 1);
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
