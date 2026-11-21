// Workerd harness for the KitebuildBackend integration tests.
//
// HostDO owns one Workspace with three Kitebuild backends: the default,
// with no network, a small JS applet toolset and a fake assets client;
// "gateway", whose egress goes through the Gateway entrypoint below
// and whose toolset replaces the built-in `assets`; and "fakes", which
// sees fake artifacts and git clients and no assets client. The test
// calls HostDO's methods directly through its stub.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { writeFdBytes } from "@cloudflare/kitebuild-runtime";
import type { JsProgramCtx, Toolset } from "@cloudflare/kitebuild-runtime";

import type { ArtifactsCLIInput, ArtifactsCLIResult } from "../src/artifacts/index";
import type { WorkspaceBackend } from "../src/backend";
import { KitebuildBackend } from "../src/backends/kitebuild/index";
import { createGitClient } from "../src/git/index";
import type { GitCliInput, GitCliResult } from "../src/git/index";
import { R2Bucket, Workspace, type WorkspaceRuntimeTruncation } from "../src/index";

export interface Env {
  HOST: DurableObjectNamespace<HostDO>;
}

export interface ExecOptions {
  backend?: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  id?: string;
}

export interface ExecResult {
  status: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated?: WorkspaceRuntimeTruncation;
}

// A toolset with one JS applet that prints an extra the toolset
// supplies, to show toolsets reach the machine.
const greeter: Toolset = {
  programs: [
    {
      path: "/usr/bin/greet",
      abi: "js",
      main: (ctx: JsProgramCtx) => {
        const bytes = new TextEncoder().encode(
          `${String(ctx.machine.extras.GREETING)} ${ctx.argv[1] ?? ""}\n`,
        );
        writeFdBytes(ctx.proc.fdt, 1, bytes, 0, bytes.length);
        return 0;
      },
    },
  ],
  extras: { GREETING: "hello" },
};

// A toolset that replaces the built-in `assets` command.
const replacement: Toolset = {
  programs: ["/usr/bin/assets", "/usr/bin/git"].map((path) => ({
    path,
    abi: "js" as const,
    main: (ctx: JsProgramCtx) => {
      const bytes = new TextEncoder().encode(`replaced ${path}\n`);
      writeFdBytes(ctx.proc.fdt, 1, bytes, 0, bytes.length);
      return 0;
    },
  })),
};

export interface Published {
  path: string;
  expiresAfter: number;
  body: string;
}

export interface ArtifactsCall {
  argv: string[];
  env: Record<string, string>;
}

export class Gateway extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    return new Response(`gateway saw ${request.method} ${request.url}\n`);
  }
}

// A one-object bucket for R2Bucket's read-only mount.
const readmeBucket = {
  list: async () => ({ objects: [{ key: "readme.txt", size: 3 }], truncated: false }),
  get: async () => ({ body: new Blob(["ro\n"]).stream(), size: 3 }),
};

export class HostDO extends DurableObject<Env> {
  #workspace: Workspace;
  readonly published: Published[] = [];
  readonly artifactsCalls: ArtifactsCall[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#workspace = this.#createWorkspace();
  }

  // A fresh Workspace and backends over the same storage, as after the
  // Durable Object restarts. The old instance is abandoned, not closed.
  restart(): void {
    this.#workspace = this.#createWorkspace();
  }

  // Close the Workspace, as the Durable Object does when it shuts down,
  // and open a fresh one over the same storage.
  async closeAndReopen(): Promise<void> {
    await this.#workspace.close();
    this.#workspace = this.#createWorkspace();
  }

  // A fresh Workspace with a read-only mount at /workspace/ro holding
  // readme.txt, inside the Kitebuild backend's mounted /workspace.
  async withReadOnlyMount(): Promise<void> {
    this.#workspace = this.#createWorkspace({ "/workspace/ro": R2Bucket(readmeBucket) });
    await this.#workspace.ready();
  }

  #createWorkspace(mounts?: ConstructorParameters<typeof Workspace>[0]["mounts"]): Workspace {
    const fakes = new KitebuildBackend({ id: "fakes" });
    const withFakes: WorkspaceBackend = {
      id: fakes.id,
      type: fakes.type,
      connect: (host) =>
        fakes.connect({
          db: host.db,
          fs: host.fs,
          artifacts: this.#fakeArtifacts() as never,
          git: this.#fakeGit() as never,
        }),
    };
    const nogit = new KitebuildBackend({ id: "nogit", git: "workspace" });
    const withoutGit: WorkspaceBackend = {
      id: nogit.id,
      type: nogit.type,
      connect: (host) =>
        nogit.connect({
          ...host,
          git: {
            cli: () => Promise.reject(new Error("Workspace git is not configured.")),
          } as never,
        }),
    };
    return new Workspace({
      storage: this.ctx.storage,
      ...(mounts === undefined ? {} : { mounts }),
      git: createGitClient(),
      defaultGitIdentity: { name: "Workspace", email: "workspace@example.com" },
      assets: {
        share: async (path, { expiresAfter }) => {
          const body = await this.#workspace.fs.readFile(path, "utf8");
          this.published.push({ path, expiresAfter, body });
          return `https://assets.example/${path.split("/").pop()}`;
        },
      },
      backends: [
        new KitebuildBackend({ commands: [greeter], env: { CI: "1" } }),
        new KitebuildBackend({
          id: "gateway",
          commands: [replacement],
          egress: { mode: "http-gateway", gateway: this.ctx.exports.Gateway({}) },
        }),
        withFakes,
        withoutGit,
        new KitebuildBackend({ id: "wsgit", git: "workspace" }),
        new KitebuildBackend({
          id: "gitfetch",
          git: { fetch: (request, send) => this.#gitFetch(request, send) },
        }),
        new KitebuildBackend({
          id: "gitdirect",
          egress: { mode: "direct" },
          git: { fetch: (request, send) => this.#gitFetch(request, send) },
        }),
        new KitebuildBackend({
          id: "gitgateway",
          egress: { mode: "http-gateway", gateway: this.ctx.exports.Gateway({}) },
          git: { fetch: (request, send) => this.#gitFetch(request, send) },
        }),
      ],
    });
  }

  // Records each call. `create` adds a remote through the command's
  // remoteAdd, as the real client does.
  #fakeArtifacts() {
    return {
      cli: async (input: ArtifactsCLIInput): Promise<ArtifactsCLIResult> => {
        this.artifactsCalls.push({ argv: input.argv, env: input.env ?? {} });
        if (input.argv[0] === "create") {
          const added = await input.remoteAdd?.({ name: "origin", url: "https://x/repo.git" });
          return { stdout: `created ${input.argv[1]}\n`, stderr: "", exitCode: added?.ok ? 0 : 1 };
        }
        return { stdout: "", stderr: "artifacts: failed\n", exitCode: 4 };
      },
    };
  }

  // Writes `git remote add` straight to the Workspace store, the way
  // the real git client writes .git/config, outside the machine.
  #fakeGit() {
    return {
      cli: async (input: GitCliInput): Promise<GitCliResult> => {
        if (input.argv[0] === "remote" && input.argv[1] === "add") {
          await this.#workspace.fs.writeFile(
            `${input.cwd}/remotes.txt`,
            `${input.argv.at(-2)} ${input.argv.at(-1)}\n`,
          );
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
  }

  readonly gitRequests: string[] = [];
  readonly gitResponses: string[] = [];

  // Stands in for an embedder's fetch: records each request git makes, sends it
  // on, and records what came back.
  async #gitFetch(
    request: Request,
    send: (request: Request) => Promise<Response>,
  ): Promise<Response> {
    this.gitRequests.push(request.url);
    const response = await send(request);
    this.gitResponses.push(await response.clone().text());
    return response;
  }

  async gitFetchRequests(): Promise<string[]> {
    return this.gitRequests;
  }

  async gitFetchResponses(): Promise<string[]> {
    return this.gitResponses;
  }

  async records(): Promise<{ published: Published[]; artifacts: ArtifactsCall[] }> {
    return { published: this.published, artifacts: this.artifactsCalls };
  }

  // Runs `second` while `first` is still running.
  async overlapping(
    first: string,
    second: string,
    options: ExecOptions = {},
  ): Promise<[ExecResult, ExecResult]> {
    const a = this.exec(first, options);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const b = await this.exec(second, options);
    return [await a, b];
  }

  async writeFile(path: string, body: string): Promise<void> {
    await this.#workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", {
      recursive: true,
    });
    await this.#workspace.fs.writeFile(path, body);
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return await this.#workspace.fs.readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.#workspace.fs.stat(path).then(
      () => true,
      () => false,
    );
  }

  async mode(path: string): Promise<number> {
    return (await this.#workspace.fs.stat(path)).mode & 0o7777;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    using handle = await this.#workspace.runtime.exec(command, { ...options, encoding: "utf8" });
    const result = await handle.result();
    return {
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
    };
  }

  // Events as they arrive, each with the time since the exec began.
  async events(command: string): Promise<Array<{ name: string; text: string; ms: number }>> {
    const started = Date.now();
    using handle = await this.#workspace.runtime.exec(command, { encoding: "utf8" });
    const events: Array<{ name: string; text: string; ms: number }> = [];
    for await (const event of handle) {
      events.push({
        name: event.name,
        text: event.name === "exit" ? String(event.code) : event.value,
        ms: Date.now() - started,
      });
    }
    return events;
  }

  async killAfter(
    command: string,
    ms: number,
    signal: "SIGTERM" | "SIGKILL",
  ): Promise<ExecResult & { ms: number }> {
    const started = Date.now();
    using handle = await this.#workspace.runtime.exec(command, { encoding: "utf8" });
    await new Promise((resolve) => setTimeout(resolve, ms));
    await handle.kill(signal);
    const result = await handle.result();
    return {
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      ms: Date.now() - started,
    };
  }

  // The error code when the execution is not found. Errors are returned
  // rather than thrown, since a rejected Durable Object call is also
  // reported as an uncaught rejection inside the object.
  async replayError(id: string): Promise<string | undefined> {
    try {
      await this.replay(id);
      return undefined;
    } catch (error) {
      return String((error as { code?: unknown }).code);
    }
  }

  async replay(id: string, backend?: string): Promise<ExecResult> {
    using handle = await this.#workspace.runtime.getExec(id, {
      resume: "full",
      encoding: "utf8",
      ...(backend === undefined ? {} : { backend }),
    });
    const result = await handle.result();
    return {
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async start(command: string, id: string): Promise<void> {
    const handle = await this.#workspace.runtime.exec(command, { id, encoding: "utf8" });
    // Let the process start before the caller restarts the object.
    await new Promise((resolve) => setTimeout(resolve, 200));
    handle[Symbol.dispose]();
  }

  async dispose(id: string): Promise<void> {
    await this.#workspace.runtime.disposeExec(id);
  }
}

export default {
  fetch: () => new Response("kitebuild backend tests"),
};
