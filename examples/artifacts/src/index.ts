// Minimal Artifacts example.
//
// POST /create { "name": "my-worker" } builds a fresh copy of
// examples/worker, rewrites its Worker name, publishes it to a new
// Cloudflare Artifacts repo, and returns a read-only clone URL.
// The Worker owns the endpoint logic. The durable object stays
// minimal: it owns the Workspace, exposes getWorkspace(), and bridges
// the host Artifacts binding into the worker-backend shell command.

import { DurableObject } from "cloudflare:workers";

import {
  type DurableObjectStorageLike,
  Workspace,
  WorkspaceServiceProxy,
  type WorkspaceStub,
} from "@cloudflare/workspace";
import { WorkerBackend, type WorkerBackendOptions } from "@cloudflare/workspace/backends/worker";

export { WorkspaceServiceProxy };

interface CreateRequest {
  name?: string;
}

interface CreateResult {
  name: string;
  artifactRepo: string;
  remote: string;
  branch: string;
  projectDir: string;
  shareLink: string;
  cloneCommand: string;
  tokenExpiresAt: string;
}

interface ArtifactCreateOutput {
  name: string;
  remote: string;
  token: string;
}

interface TokenCreateOutput {
  plaintext: string;
  expiresAt: string;
}

const WORKSPACE_ROOT = "/workspace";
const SOURCE_REPO = "https://github.com/cloudflare/workspace";
const EXAMPLE_PATH = "examples/worker";
const SHARE_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export class ArtifactCreator extends DurableObject<Env> {
  readonly #workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const workerBackendOptions: WorkerBackendOptions = {
      loader: env.LOADER as unknown as WorkerBackendOptions["loader"],
      workspace: { binding: "ArtifactCreator", id: ctx.id.toString() },
      ctx,
    };
    this.#workspace = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      sessionId: ctx.id.toString(),
      artifacts: { binding: env.ARTIFACTS },
      backends: [new WorkerBackend(workerBackendOptions)],
    });
  }

  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#workspace.ready();
    return this.#workspace.stub();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        [
          "workspace artifacts example",
          "",
          "POST /create",
          '  body: { "name": "my-worker" }',
          "",
          "curl -X POST https://<worker>/create \\",
          "  -H 'content-type: application/json' \\",
          '  -d \'{"name":"my-worker"}\'',
          "",
          "Builds examples/worker in a Workspace and pushes it to a",
          "new Cloudflare Artifacts repo.",
        ].join("\n"),
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    if (url.pathname === "/create") return handleCreate(request, env);

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleCreate(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  }

  let body: CreateRequest;
  try {
    body = (await request.json()) as CreateRequest;
  } catch {
    return errorJSON(new Error("invalid JSON body"), 400);
  }

  if (typeof body.name !== "string") {
    return errorJSON(new Error("name must be a string"), 400);
  }
  const name = body.name.trim();
  if (!isValidWorkerName(name)) {
    return errorJSON(
      new Error(
        "name must start with a lowercase letter or digit and contain only lowercase letters, digits, and hyphens",
      ),
      400,
    );
  }

  const stub = env.ArtifactCreator.get(env.ArtifactCreator.idFromName(name));
  // `wrangler types` exposes returned RpcTarget instances as
  // Rpc.Stub<T>, which loses the concrete overloads on nested
  // members. Runtime-wise this is still the WorkspaceStub surface,
  // so cast once at the boundary and keep the rest of the example
  // readable.
  const ws = (await stub.getWorkspace()) as unknown as WorkspaceStub;
  const sourceDir = `${WORKSPACE_ROOT}/${name}-source`;
  const projectDir = `${WORKSPACE_ROOT}/${name}`;
  let createdRepo = false;

  try {
    await exec(
      ws,
      [
        `rm -rf ${shellQuote(sourceDir)} ${shellQuote(projectDir)}`,
        `git clone --depth 1 ${shellQuote(SOURCE_REPO)} ${shellQuote(sourceDir)}`,
        `mkdir -p ${shellQuote(projectDir)}`,
        `cp -R ${shellQuote(`${sourceDir}/${EXAMPLE_PATH}/.`)} ${shellQuote(projectDir)}`,
        `sed -i ${shellQuote(`s/"name"[[:space:]]*:[[:space:]]*"[^"]*"/"name": "${name}"/`)} ${shellQuote(`${projectDir}/wrangler.jsonc`)}`,
        `sed -i ${shellQuote(`s/"name"[[:space:]]*:[[:space:]]*"[^"]*"/"name": "@example\\/${name}"/`)} ${shellQuote(`${projectDir}/package.json`)}`,
        `git init --initial-branch=main ${shellQuote(projectDir)}`,
        `cat ${shellQuote(`${projectDir}/.git/HEAD`)} >/dev/null`,
        "git add .",
        `git commit -m ${shellQuote(`Create ${name} worker example`)} --author ${shellQuote("Cloudflare Workspace Artifacts Example <workspace-artifacts@example.invalid>")}`,
      ].join(" && "),
      { cwd: projectDir },
    );

    // Make the demo easy to rerun with the same name. The repo is
    // session-scoped by createArtifact() inside the durable object,
    // so this only replaces the project this endpoint owns.
    await exec(ws, `artifacts repo delete ${shellQuote(name)} || true`);
    const created = parseJSON<ArtifactCreateOutput>(
      await exec(
        ws,
        [
          "artifacts repo create",
          shellQuote(name),
          "--default-branch main",
          `--description ${shellQuote(`Generated from ${SOURCE_REPO}/${EXAMPLE_PATH}`)}`,
        ].join(" "),
      ),
    );
    createdRepo = true;

    const pushRemote = authenticatedArtifactRemote(created.remote, created.token);
    await exec(ws, `git push --force ${shellQuote(pushRemote)} HEAD:main`, {
      cwd: projectDir,
      secretToRedact: pushRemote,
    });

    const readToken = parseJSON<TokenCreateOutput>(
      await exec(
        ws,
        `artifacts token create ${shellQuote(name)} --scope read --ttl ${SHARE_TOKEN_TTL_SECONDS}`,
      ),
    );
    const shareLink = authenticatedArtifactRemote(created.remote, readToken.plaintext);

    return Response.json({
      name,
      artifactRepo: created.name,
      remote: created.remote,
      branch: "main",
      projectDir,
      shareLink,
      cloneCommand: `git clone ${shellQuote(shareLink)} ${shellQuote(name)}`,
      tokenExpiresAt: readToken.expiresAt,
    } satisfies CreateResult);
  } catch (cause) {
    if (createdRepo) await exec(ws, `artifacts repo delete ${shellQuote(name)}`).catch(() => "");
    return errorJSON(cause, isAlreadyExists(cause) ? 409 : 500);
  } finally {
    ws[Symbol.dispose]?.();
  }
}

async function exec(
  ws: WorkspaceStub,
  command: string,
  options: { cwd?: string; secretToRedact?: string } = {},
): Promise<string> {
  const handle = await ws.shell.exec(command, { cwd: options.cwd, encoding: "utf8" });
  try {
    const result = await handle.result();
    if (result.exitCode === 0) return result.stdout;

    const raw = result.stderr || result.stdout || `exit code ${result.exitCode}`;
    const output = options.secretToRedact
      ? raw.replaceAll(options.secretToRedact, "<artifact-remote>")
      : raw;
    throw new Error(`command failed: ${output}`);
  } finally {
    handle[Symbol.dispose]?.();
  }
}

function parseJSON<T>(text: string): T {
  return JSON.parse(text) as T;
}

function isValidWorkerName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
}

function isAlreadyExists(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.name === "ArtifactsError" &&
    (cause as { code?: unknown }).code === "ALREADY_EXISTS"
  );
}

function authenticatedArtifactRemote(remote: string, token: string): string {
  const secret = token.split("?expires=", 1)[0];
  return `https://x:${encodeURIComponent(secret)}@${remote.slice("https://".length)}`;
}

function errorJSON(error: unknown, status: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;
  return Response.json({ error: message, code }, { status });
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-+=:,./@%]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'"'"'`)}'`;
}
