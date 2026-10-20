/**
 * Assistant — a minimal `@cloudflare/think` chat agent backed by a
 * `@cloudflare/computer` VFS.
 *
 * Think gives the Durable Object a streaming chat protocol, message
 * persistence, resumable streams, the agentic tool loop, and the
 * `@cloudflare/computer` workspace tools. This example keeps the surface
 * as small as possible: one agent, one Workspace, and nothing
 * task-specific. You talk to it from a terminal (see `cli/chat.mjs`)
 * and it can read, write, and edit files in its workspace and run
 * shell commands through either workspace backend.
 *
 * Wiring:
 *   - `Think` (via the Durable Object base) hands us the message
 *     store, agentic loop, and chat protocol.
 *   - We own a `@cloudflare/computer.Workspace` with two backends:
 *     a WorkerShellBackend (`"shell"`) for fast just-bash text tooling and
 *     a ContainerBackend (`"container"`) for full Linux
 *     userland through computerd. This mirrors examples/container while
 *     keeping the chat surface unchanged.
 *   - Think adds the workspace tools (`read`, `write`, `edit`, `exec`,
 *     ...) and hands out the Workspace stub the worker backend calls
 *     back through.
 */

import { Workspace, WorkspaceProxy, WorkspaceServiceProxy } from "@cloudflare/computer";
import { ContainerBackend, withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";

// Re-export so the runtime can build loopback bindings. The
// WorkerShellBackend reaches WorkspaceServiceProxy through
// `ctx.exports.WorkspaceServiceProxy(...)` so the in-isolate shell
// can call back into the host workspace. WorkspaceProxy carries the
// container's outbound /api egress back to this DO.
export { WorkspaceProxy, WorkspaceServiceProxy };

const MODEL_ID = "@cf/zai-org/glm-5.2";

// Identifies this durable object to both backends: the worker
// backend's loopback Fetcher and the container's egress table route
// back to the Workspace by binding name and id.
function workspaceRef(ctx: DurableObjectState) {
  return { binding: "Assistant", id: ctx.id.toString() };
}

// Anchor Think's generic before the mixin so withWorkspaceContainer
// sees a concrete constructor.
class AssistantBase extends Think<Env> {}

export class Assistant extends withWorkspaceContainer(AssistantBase) {
  /** Plenty of budget for a chat turn that reads a few files first. */
  override maxSteps = 20;

  /**
   * Container backend used when `exec` needs a real Linux userland.
   * The DO itself owns the container binding through the
   * withWorkspaceContainer mixin; ContainerBackend handles
   * startup, outbound egress interception, the /api upgrade, and the
   * capnweb session.
   */
  readonly #containerBackend = new ContainerBackend({
    id: "container",
    container: () => this,
    workspace: workspaceRef(this.ctx),
    egress: { mode: "direct" },
    // The durable object schedules this container, so it asks for its
    // size at launch; wrangler.jsonc names the image under `images.app`.
    instance: "standard-2",
  });

  /**
   * Think's workspace, owned outright. The first backend in the list
   * is the default, so unqualified exec calls use the fast just-bash
   * shell. Passing `{ backend: "container" }` routes a call to computerd in
   * the Cloudflare Container.
   */
  override workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [
      new WorkerShellBackend({
        id: "shell",
        loader: this.env.LOADER,
        workspace: workspaceRef(this.ctx),
        ctx: this.ctx,
      }),
      this.#containerBackend,
    ],
  });

  /** Forwarded by WorkspaceProxy for computerd's outbound /api upgrade. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api") {
      return this.#containerBackend.handleFetch(request);
    }
    return super.fetch(request);
  }

  override getModel() {
    return createWorkersAI({ binding: this.env.AI })(MODEL_ID);
  }

  override getSystemPrompt(): string {
    return [
      "You are a helpful assistant with a Cloudflare Workspace as your",
      "working directory, rooted at /workspace.",
      "",
      "Tools, in preference order:",
      "  - read, ls:    inspect the working tree. Prefer these over",
      "                 `exec cat` / `exec ls`.",
      "  - write, edit: create and modify files. Prefer these over",
      "                 `exec sed` / shell heredocs.",
      "  - exec:        run shell commands. Name a backend on every call.",
      "                 Try backend `shell` first: it is just-bash in a Dynamic",
      "                 Worker, cold-starts quickly, and includes `git`",
      "                 (clone / status / diff / log) via the host",
      "                 workspace. Only https:// git URLs are supported.",
      "                 Use backend `container` when you need full Linux",
      "                 userland: npm, node, python, package managers,",
      "                 test runners, or other real binaries.",
      "",
      "Keep replies concise. Use the tools instead of guessing about",
      "files you can read. When an `exec` command fails because the",
      "selected backend lacks a tool, retry on a backend whose",
      "description covers that command.",
    ].join("\n");
  }
}
