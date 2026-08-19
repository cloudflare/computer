import { DurableObject } from "cloudflare:workers";
import {
  type DurableObjectStorageLike,
  getWorkspace,
  type WorkspaceOptions,
  WorkspaceProxy,
  withWorkspace,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";

export { WorkspaceProxy };

type Env = {
  ReproContainer: DurableObjectNamespace<ReproContainer>;
};

class ContainerBase extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly backend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: "ReproContainer", id: this.ctx.id.toString() },
    egress: { mode: "direct" },
  });
}

function workspaceOptions(self: InstanceType<typeof ContainerBase>): WorkspaceOptions {
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [self.backend],
  };
}

export class ReproContainer extends withWorkspace(ContainerBase, workspaceOptions) {
  override fetch(request: Request): Promise<Response> {
    return this.backend.handleFetch(request);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `; cause=${error.cause.message}` : "";
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/run") {
      return new Response("Not found", { status: 404 });
    }
    const startedAt = Date.now();
    // A fixed identity lets a maintainer retry from the UI while still using
    // a real deployed, container-enabled Durable Object.
    const stub = env.ReproContainer.get(env.ReproContainer.idFromName("demo-0.2.1"));
    try {
      const workspace = await getWorkspace(
        stub as unknown as Parameters<typeof getWorkspace>[0],
      );
      const handle = await workspace.runtime.exec("printf 'transport-ok\\n'", {
        encoding: "utf8",
      });
      const result = await handle.result();
      return Response.json({
        packageVersion: "0.2.1",
        image: "ghcr.io/cloudflare/computer-computerd-linux-x64:0.2.1",
        ok: true,
        elapsedMs: Date.now() - startedAt,
        result,
      });
    } catch (error) {
      return Response.json(
        {
          packageVersion: "0.2.1",
          image: "ghcr.io/cloudflare/computer-computerd-linux-x64:0.2.1",
          ok: false,
          elapsedMs: Date.now() - startedAt,
          error: describeError(error),
        },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Env>;
