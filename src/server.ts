import {
  getWorkspace,
  type DurableObjectStorageLike,
  withWorkspace,
} from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import { Agent, routeAgentRequest } from "agents";

interface AgentEnv {}

type Env = {
  ReproAgent: DurableObjectNamespace<ReproAgent>;
};

class ReproAgentBase extends Agent<AgentEnv> {}

export class ReproAgent extends withWorkspace(ReproAgentBase, (self) => {
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    git: createGitClient(),
  };
}) {
  override async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/run")) {
      return new Response("POST /run to execute the reproduction", { status: 405 });
    }

    const ws = await getWorkspace(this);
    const dir = "/";
    const gitDir = "/.git";

    const result: Record<string, unknown> = {
      packageVersion: "@cloudflare/computer@0.2.1",
      dir,
    };

    await ws.fs.writeFile("/hello.txt", "hello from issue 133\n");

    // Match the report exactly: probe status before init on the fresh workspace.
    result.statusBeforeInit = await capture(() => ws.git.status({ dir }));

    result.init = await capture(async () => {
      await ws.git.init({ dir, defaultBranch: "main" });
      return "resolved";
    });
    result.afterInit = {
      gitEntries: await readDirNames(ws.fs, gitDir),
      head: await capture(() => ws.fs.readFile(`${gitDir}/HEAD`, "utf8")),
      config: await capture(() => ws.fs.readFile(`${gitDir}/config`, "utf8")),
    };

    result.add = await capture(async () => {
      await ws.git.add({ dir, paths: ["hello.txt"] });
      return "resolved";
    });
    result.statusAfterAdd = await capture(() => ws.git.status({ dir }));
    result.commit = await capture(() =>
      ws.git.commit({
        dir,
        message: "first commit",
        author: { name: "Repro", email: "repro@example.test" },
      }),
    );
    result.afterCommit = {
      gitEntries: await readDirNames(ws.fs, gitDir),
      head: await capture(() => ws.fs.readFile(`${gitDir}/HEAD`, "utf8")),
    };

    result.directWriteProbe = await capture(async () => {
      await ws.fs.writeFile("/.ordinary-dotfile", "persists\n");
      await ws.fs.writeFile(`${gitDir}/HEAD`, "ref: refs/heads/main\n");
      return {
        ordinaryDotfile: await capture(() =>
          ws.fs.readFile("/.ordinary-dotfile", "utf8"),
        ),
        gitHead: await capture(() => ws.fs.readFile(`${gitDir}/HEAD`, "utf8")),
        gitEntries: await readDirNames(ws.fs, gitDir),
      };
    });

    return Response.json(result, {
      headers: { "cache-control": "no-store" },
    });
  }
}

async function capture<T>(operation: () => Promise<T>): Promise<
  | { ok: true; value: T }
  | { ok: false; error: string }
> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

async function readDirNames(
  fs: { readdir(path: string): Promise<Array<{ name: string }>> },
  path: string,
): Promise<unknown> {
  return capture(async () => (await fs.readdir(path)).map((entry) => entry.name).sort());
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routeAgentRequest(request, env)) || new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
