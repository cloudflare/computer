// Workerd test harness for the WorkerBackend integration tests.
//
// Three exports:
//
//   - WorkspaceServiceProxy — re-exported from the package so the
//     runtime can wrap it into a loopback Fetcher. The worker
//     backend's loader callback wires this as env.HOST inside the
//     Dynamic Worker; the loaded ShellWorker reaches it through
//     env.HOST.getWorkspace().
//   - HostDO — the host Durable Object. Owns one Workspace whose
//     only backend is a WorkerBackend dialing through env.LOADER.
//     Exposes writeFile / readFile / exec methods the test calls
//     directly through the DO stub; the exec method goes through
//     workspace.shell.exec which actually drives just-bash in a
//     real Dynamic Worker.
//   - default — a tiny WorkerEntrypoint that routes incoming
//     fetches into the DO. Lets the test drive the harness with
//     SELF.fetch instead of holding a DO reference itself.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { WorkerBackend } from "../src/backends/worker/index.js";
import { type DurableObjectStorageLike, getWorkspace, withWorkspace } from "../src/index.js";

export { WorkspaceServiceProxy } from "../src/proxy.js";

export interface Env {
  HOST: DurableObjectNamespace<HostDO>;
  LOADER: WorkerLoader;
}

export class HostDO extends withWorkspace(class extends DurableObject<Env> {}, (self) => {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: Env };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerBackend({
        loader: env.LOADER,
        workspace: { binding: "HOST", id: ctx.id.toString() },
        ctx,
      }),
    ],
  };
}) {
  #seeded: Promise<void> | undefined;

  // The VFS is empty on a fresh DO — not even /workspace exists.
  // The computerd-container example seeds the mount root through computerd's
  // boot path; the worker example happens to seed it through an
  // R2 mount at /workspace/r2. This harness has neither, so seed
  // /workspace directly.
  #seed(): Promise<void> {
    if (this.#seeded === undefined) {
      this.#seeded = (async () => {
        using ws = await getWorkspace(this);
        await ws.fs.mkdir("/workspace", { recursive: true });
      })();
    }
    return this.#seeded;
  }

  async writeFile(path: string, body: string): Promise<void> {
    await this.#seed();
    using ws = await getWorkspace(this);
    await ws.fs.writeFile(path, body);
  }

  async readFile(path: string): Promise<string> {
    using ws = await getWorkspace(this);
    return ws.fs.readFile(path, "utf8");
  }

  async exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.#seed();
    using ws = await getWorkspace(this);
    const handle = await ws.shell.exec(command, {
      encoding: "utf8",
    });
    const result = await handle.result();
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}

export default class extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "default";
    const stub = this.env.HOST.get(this.env.HOST.idFromName(id));

    if (url.pathname === "/write") {
      const path = url.searchParams.get("path") ?? "/note.txt";
      const body = await request.text();
      await stub.writeFile(path, body);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/read") {
      const path = url.searchParams.get("path") ?? "/note.txt";
      try {
        const text = await stub.readFile(path);
        return new Response(text, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        return new Response(String(error), { status: code === "ENOENT" ? 404 : 500 });
      }
    }

    if (url.pathname === "/exec") {
      const command = url.searchParams.get("command") ?? "true";
      const result = await stub.exec(command);
      return Response.json(result);
    }

    return new Response("not found", { status: 404 });
  }
}
