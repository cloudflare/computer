// Workerd test harness for the WorkerShellBackend integration tests.
//
// Three exports:
//
//   - WorkspaceServiceProxy — re-exported from the package so the
//     runtime can wrap it into a loopback Fetcher. The worker
//     backend's loader callback wires this as env.HOST inside the
//     Dynamic Worker; the loaded ShellWorker reaches it through
//     env.HOST.getWorkspace().
//   - HostDO — the host Durable Object. Owns one Workspace whose
//     only backend is a WorkerShellBackend dialing through env.LOADER.
//     Exposes writeFile / readFile / exec methods the test calls
//     directly through the DO stub; the exec method goes through
//     workspace.runtime.exec which actually drives just-bash in a
//     real Dynamic Worker.
//   - default — a tiny WorkerEntrypoint that routes incoming
//     fetches into the DO. Lets the test drive the harness with
//     SELF.fetch instead of holding a DO reference itself.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import curlModules from "@cloudflare/computer/shell/curl";
import { WorkerShellBackend } from "../src/backends/worker-shell/index.js";
import type { DurableObjectStorageLike, WorkspaceStub } from "../src/index.js";
import { Workspace } from "../src/index.js";

export { WorkspaceServiceProxy } from "../src/proxy.js";

export interface Env {
  HOST: DurableObjectNamespace<HostDO>;
  LOADER: WorkerLoader;
}

export class HostDO extends DurableObject<Env> {
  readonly #workspace: Workspace;
  #seeded: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#workspace = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends: [
        new WorkerShellBackend({
          loader: env.LOADER,
          workspace: { binding: "HOST", id: ctx.id.toString() },
          ctx,
          // Opt curl in by importing its group and passing it; the
          // fetch-path curl integration test exercises the wiring.
          commands: [curlModules],
        }),
      ],
    });
  }

  // The VFS is empty on a fresh DO — not even /workspace exists.
  // The computerd-container example seeds the mount root through computerd's
  // boot path; the worker example happens to seed it through an
  // R2 mount at /workspace/r2. This harness has neither, so seed
  // /workspace directly.
  #seed(): Promise<void> {
    if (this.#seeded === undefined) {
      this.#seeded = this.#workspace.fs.mkdir("/workspace", { recursive: true });
    }
    return this.#seeded;
  }

  // Required by WorkspaceServiceProxy: the loopback proxy looks
  // the host DO up by name and calls __getWorkspaceStub() to obtain the
  // stub it returns to the Dynamic Worker. The shell's per-exec
  // env.HOST.getWorkspace() proxy call lands here.
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.#workspace.ready();
    return this.#workspace.stub();
  }

  async writeFile(path: string, body: string): Promise<void> {
    await this.#seed();
    await this.#workspace.fs.writeFile(path, body);
  }

  async readFile(path: string): Promise<string> {
    return this.#workspace.fs.readFile(path, "utf8");
  }

  async exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.#seed();
    const handle = await this.#workspace.runtime.exec(command, {
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
