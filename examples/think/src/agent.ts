/**
 * Assistant — a minimal `@cloudflare/think` chat agent backed by a
 * `@cloudflare/computer` VFS.
 *
 * Think gives the Durable Object a streaming chat protocol, message
 * persistence, resumable streams, and the agentic tool loop. This
 * example keeps the surface as small as possible: one agent, one
 * Workspace, the shared `@cloudflare/computer/tools`, and nothing
 * task-specific. You talk to it from a terminal (see `cli/chat.mjs`)
 * and it can read, write, and edit files in its workspace and run
 * shell commands through either workspace backend.
 *
 * Wiring:
 *   - `Think` (via the Durable Object base) hands us the message
 *     store, agentic loop, and chat protocol.
 *   - We own a `@cloudflare/computer.Workspace` with two backends:
 *     a WorkerShellBackend (`"shell"`) for fast just-bash text tooling and
 *     a CloudflareContainerBackend (`"container"`) for full Linux
 *     userland through computerd. This mirrors examples/container while
 *     keeping the chat surface unchanged.
 *   - `useThink: true` adds the string-based compatibility surface
 *     Think expects; the cast promotes it from optional to present.
 *     `workspaceBash` is off because `@cloudflare/computer/tools`
 *     provides the `exec` tool.
 */

import {
  type DurableObjectStorageLike,
  type ThinkWorkspaceCompatibility,
  Workspace,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type WorkspaceStub,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createAITools } from "@cloudflare/computer/tools";
import { Think } from "@cloudflare/think";
import type { ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";

// Re-export so the runtime can build loopback bindings. The
// WorkerShellBackend reaches WorkspaceServiceProxy through
// `ctx.exports.WorkspaceServiceProxy(...)` so the in-isolate shell
// can call back into the host workspace. WorkspaceProxy carries the
// container's outbound /ws egress back to this DO.
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
  /** We have a dedicated `exec` tool; skip Think's built-in bash. */
  override workspaceBash = false;

  /** Plenty of budget for a chat turn that reads a few files first. */
  override maxSteps = 20;

  /**
   * Container backend used when `exec` needs a real Linux userland.
   * The DO itself owns the container binding through the
   * withWorkspaceContainer mixin; CloudflareContainerBackend handles
   * startup, outbound egress interception, the /ws upgrade, and the
   * capnweb session.
   */
  readonly #containerBackend = new CloudflareContainerBackend({
    id: "container",
    container: () => this,
    workspace: workspaceRef(this.ctx),
    egress: { mode: "direct" },
  });

  /**
   * Think's workspace, owned outright. The first backend in the list
   * is the default, so unqualified exec calls use the fast just-bash
   * shell. Passing `{ backend: "container" }` routes a call to computerd in
   * the Cloudflare Container.
   */
  override workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerShellBackend({
        id: "shell",
        loader: this.env.LOADER,
        workspace: workspaceRef(this.ctx),
        ctx: this.ctx,
      }),
      this.#containerBackend,
    ],
    useThink: true,
  }) as Workspace & ThinkWorkspaceCompatibility;

  /** Forwarded by WorkspaceProxy for computerd's outbound /ws upgrade. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return this.#containerBackend.handleFetch(request);
    }
    return super.fetch(request);
  }

  /**
   * Hand out a typed RPC stub to the workspace. The worker backend's
   * WorkspaceServiceProxy dispatches to this so the in-isolate shell
   * can reach back into the host workspace; WorkspaceProxy uses the
   * same method for the container's capnweb egress path.
   */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.workspace.ready();
    return this.workspace.stub();
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
      "  - exec:        run shell commands. Use the default `shell`",
      "                 backend first: it is just-bash in a Dynamic",
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

  override getTools(): ToolSet {
    return createAITools({
      workspace: this.workspace,
      shell: {
        defaultBackend: "shell",
        backends: {
          shell: {
            description:
              "just-bash in a Dynamic Worker. Cold-start fast, no " +
              "container, no public network. Good for cat / grep / sed / " +
              "awk / jq / head / tail / sort / find, quick file " +
              "inspection, text transformations, and `git` (clone / " +
              "status / diff / log) — the shell registers a built-in " +
              "`git` command that forwards to the host workspace, so " +
              "network-bound subcommands like `git clone` work even " +
              "though the isolate itself has no public network. Only " +
              "https:// URLs are supported. Cannot run npm, node, python, " +
              "or any binary outside just-bash's built-in command set.",
          },
          container: {
            description:
              "Cloudflare Container running computerd over capnweb. Full Linux " +
              "userland: npm, node, python, package managers, test " +
              "runners, real binaries on $PATH, and public network. Cold " +
              "start is much slower because the container must boot; " +
              "reach for it when the shell backend can't run the command. " +
              "For git itself, prefer the shell backend.",
          },
        },
      },
    });
  }
}
