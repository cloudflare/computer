import { getSandbox, type Sandbox as SandboxDO } from "@cloudflare/sandbox";
import { type ContainerPoolConfigEnv, containerSleepAfter } from "./container-config";
import type { WarmPoolRuntime } from "./container-pool-manager";
import { ContainerWarmPool } from "./container-warm-pool";

export interface SandboxPoolEnv extends ContainerPoolConfigEnv {
  Sandbox: DurableObjectNamespace<SandboxDO>;
}

export class SandboxWarmPool extends ContainerWarmPool<SandboxPoolEnv> {
  protected createRuntime(env: SandboxPoolEnv): WarmPoolRuntime {
    return createSandboxWarmPoolRuntime(env);
  }
}

function createSandboxWarmPoolRuntime(env: SandboxPoolEnv): WarmPoolRuntime {
  return {
    async startContainer(containerId) {
      const sandbox = getSandbox(env.Sandbox, containerId, {
        sleepAfter: containerSleepAfter(env),
      });
      await sandbox.exec("true");
    },
    async destroyContainer(containerId) {
      await getSandbox(env.Sandbox, containerId, {
        sleepAfter: containerSleepAfter(env),
      }).destroy();
    },
    async isContainerRunning(containerId) {
      const stub = getDurableObjectByName(
        env.Sandbox,
        containerId,
      ) as unknown as ContainerStateStub;
      try {
        const state = await stub.getState();
        return state.status === "running" || state.status === "healthy";
      } catch {
        return false;
      }
    },
    async keepContainerAlive(containerId) {
      const stub = getDurableObjectByName(env.Sandbox, containerId) as unknown as {
        renewActivityTimeout?: () => void;
      };
      stub.renewActivityTimeout?.();
    },
  };
}

function getDurableObjectByName(
  namespace: DurableObjectNamespace,
  name: string,
): DurableObjectStub {
  return namespace.get(namespace.idFromName(name));
}

interface ContainerStateStub {
  getState(): Promise<{
    status: "running" | "stopping" | "stopped" | "healthy" | "stopped_with_code";
  }>;
}
