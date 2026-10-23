// SimpleContainerBackend: a container that shares no files with the
// Workspace until it is told to.
//
// ContainerBackend mounts the Workspace into the container over FUSE
// and keeps the two in step with the sync protocol, pushing pending
// writes before every command and pulling the container's changes
// after it. That is the right shape for a shell the model drives
// directly. It is the wrong shape for a build step, where every file
// read crosses FUSE and every command pays for a sync bracket.
//
// This backend runs the same container with no mount point at all. Its
// filesystem is its own, commands run at native speed, and nothing
// syncs. Files move only when code asks, and a path means the same
// thing on both sides: /workspace/src/a.ts in the Workspace is
// /workspace/src/a.ts in the container.
//
//   import { exec, push, pull } from "ws:container";
//
//   await push(["/workspace/package.json", "/workspace/src"]);
//   await exec("npm ci && npm run build", { cwd: "/workspace" });
//   await pull(["/workspace/dist"]);
//
// Install it with createContainerModule({ backend }) so ws:container
// exports push and pull alongside exec.
//
// Under the hood it is a ContainerBackend: the same lifecycle, the same
// dial-back and client secret, and the same exec over capnweb. It
// launches computerd with `mount: false` (FUSE_MOUNT=none, no
// MOUNT_POINT), reports `sync: "none"` so the runtime skips the sync
// bracket, and moves files over computerd's file transfer routes.

import type { BackendHandle, WorkspaceBackend } from "../../backend.js";
import { ContainerBackend, type ContainerBackendOptions } from "../container/container-backend.js";
import {
  type PullResult,
  type PushResult,
  pullFiles,
  pushFiles,
  type TransferFilesystem,
  type TransferOptions,
} from "./file-transfer.js";

// Both ends are rooted at "/", so paths need no mapping.
const ROOT = "/";

/** Options for {@link SimpleContainerBackend}. */
export type SimpleContainerBackendOptions = Omit<ContainerBackendOptions, "ignore" | "mount">;

/**
 * Runs shell commands in a Cloudflare Container whose filesystem is
 * not synced with the Workspace. Copy files in with {@link push} and
 * back out with {@link pull}, usually through `ws:container`.
 *
 * There is no mount point. Paths are absolute and mean the same file on
 * both sides; a relative pattern is taken from the root, `/`.
 *
 * Experimental: this API may change in any release and is not yet
 * suitable for production use.
 */
export class SimpleContainerBackend implements WorkspaceBackend {
  readonly type = "simple-container";
  readonly id: string;
  readonly description: string;
  readonly #container: ContainerBackend;

  constructor(options: SimpleContainerBackendOptions) {
    this.#container = new ContainerBackend({
      ...options,
      id: options.id ?? "container-shell",
      mount: false,
    });
    this.id = this.#container.id;
    this.description = [
      this.#container.description,
      "Its filesystem is not shared with the workspace: copy files in with push() and results out with pull(). A path is the same file on both sides. Pass `cwd` to choose where a command runs.",
    ].join(" ");
  }

  /**
   * Start the container and open the command session. The handle
   * declares `sync: "none"`, so the Workspace neither syncs before or
   * after a command nor reconciles on connect.
   */
  async connect(): Promise<BackendHandle> {
    const handle = await this.#container.connect();
    return { ...handle, sync: "none" };
  }

  /**
   * Route a request the container sends back to this Durable Object.
   * Forward the Workspace proxy's fetch here, as for ContainerBackend.
   */
  handleFetch(request: Request): Promise<Response> {
    return this.#container.handleFetch(request);
  }

  /**
   * Copy Workspace files matching `patterns` into the container at the
   * same paths, starting it if needed. Only files the container lacks
   * or holds at an older revision are sent.
   *
   * @param fs - The Workspace filesystem to read.
   * @param patterns - Globs or paths, absolute or relative to `/`. A
   *   plain path names a file or a whole directory.
   */
  push(
    fs: TransferFilesystem,
    patterns: readonly string[],
    options?: TransferOptions,
  ): Promise<PushResult> {
    return pushFiles(fs, this.#fetch, ROOT, patterns, options);
  }

  /**
   * Copy container files matching `patterns` into the Workspace at the
   * same paths, starting the container if needed. Only files the
   * container changed since they last matched the Workspace are sent.
   *
   * computerd remembers, in memory, the Workspace revision and content
   * hash of every file it pushed or pulled. A file the container changed
   * whose Workspace revision has moved on since is a conflict, and the
   * pull is refused as a whole, writing nothing, with a
   * `FileTransferConflictError`. Pass `force` to overwrite regardless.
   * A restarted computerd has forgotten its record, so a container file
   * that looks changed against an existing Workspace copy is refused as
   * `"untracked"`.
   *
   * @param fs - The Workspace filesystem to write.
   * @param patterns - As for {@link push}. `/proc`, `/sys` and `/dev`
   *   are never read.
   */
  pull(
    fs: TransferFilesystem,
    patterns: readonly string[],
    options?: TransferOptions,
  ): Promise<PullResult> {
    return pullFiles(fs, this.#fetch, ROOT, patterns, options);
  }

  readonly #fetch = (path: string, init: RequestInit) => this.#container.fetchComputerd(path, init);
}
