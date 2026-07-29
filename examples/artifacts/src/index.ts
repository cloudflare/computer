// Minimal Artifacts example.
//
// POST /create { "name": "my-worker" } builds a fresh copy of
// examples/worker, rewrites its Worker name, publishes it to a new
// Cloudflare Artifacts repo, and returns a read-only clone URL.
// The Worker owns the endpoint logic. The durable object stays
// minimal: it constructs the Workspace with `this` so the Worker can
// reach it through getWorkspace(stub), and bridges the host Artifacts
// binding into the worker-backend shell command.

import { DurableObject } from "cloudflare:workers";

import {
  type DurableObjectStorageLike,
  getWorkspace,
  sh,
  type WorkspaceClient,
  WorkspaceServiceProxy,
  withWorkspace,
} from "@cloudflare/computer";
import { WorkerBackend, type WorkerBackendOptions } from "@cloudflare/computer/backends/worker";

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
}

interface ArtifactCreateOutput {
  name: string;
  remote: string;
  gitRemote: string;
  credentialedRemote: string;
}

const WORKSPACE_ROOT = "/workspace";
const SOURCE_REPO = "https://github.com/cloudflare/computer";
const EXAMPLE_PATH = "examples/worker";
const GIT_REMOTE = "origin";
const SHARE_TOKEN_TTL = "24h";

// Extending `withWorkspace` gives the durable object a Workspace and
// the plumbing `getWorkspace` needs, with no hand-written method. The
// callback runs after `super(...)`, so it can read `self.ctx` /
// `self.env`.
export class ArtifactCreator extends withWorkspace(class extends DurableObject<Env> {}, (self) => {
  const { ctx, env } = self as unknown as { ctx: DurableObjectState; env: Env };
  const workerBackendOptions: WorkerBackendOptions = {
    loader: env.LOADER as unknown as WorkerBackendOptions["loader"],
    workspace: { binding: "ArtifactCreator", id: ctx.id.toString() },
    ctx,
  };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    sessionId: ctx.id.toString(),
    artifacts: { binding: env.ARTIFACTS },
    backends: [new WorkerBackend(workerBackendOptions)],
  };
}) {}

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
  // `wrangler types` doesn't surface the `__getWorkspaceStub` accessor
  // the `withWorkspace` mixin installs, so cast once at the boundary
  // and keep the rest readable.
  const ws = await getWorkspace(stub as unknown as Parameters<typeof getWorkspace>[0]);
  const sourceDir = `${WORKSPACE_ROOT}/${name}-source`;
  const projectDir = `${WORKSPACE_ROOT}/${name}`;

  try {
    await exec(
      ws,
      [
        sh`rm -rf ${sourceDir} ${projectDir}`,
        sh`git clone --depth 1 ${SOURCE_REPO} ${sourceDir}`,
        sh`mkdir -p ${projectDir}`,
        sh`cp -R ${`${sourceDir}/${EXAMPLE_PATH}/.`} ${projectDir}`,
        sh`sed -i ${`s/"name"[[:space:]]*:[[:space:]]*"[^"]*"/"name": "${name}"/`} ${`${projectDir}/wrangler.jsonc`}`,
        sh`sed -i ${`s/"name"[[:space:]]*:[[:space:]]*"[^"]*"/"name": "@example\\/${name}"/`} ${`${projectDir}/package.json`}`,
        sh`git init --initial-branch=main ${projectDir}`,
        sh`cat ${`${projectDir}/.git/HEAD`} >/dev/null`,
        "git add .",
        sh`git commit -m ${`Create ${name} worker example`} --author ${"Cloudflare Computer Artifacts Example <computer-artifacts@example.invalid>"}`,
      ].join(" && "),
      { cwd: projectDir },
    );

    // One command does the three setup steps: create the repo, mint
    // a write token, and register the credentialed remote as
    // `origin` in the project. `--force` makes the demo rerunnable
    // with the same name — the repo is session-scoped by
    // createArtifact() in the durable object, so this only touches
    // the project this endpoint owns. The credentialed remote URL is
    // a secret, so it is redacted from any error output.
    const created = parseJSON<ArtifactCreateOutput>(
      await exec(
        ws,
        sh`artifacts create ${name} --remote ${GIT_REMOTE} --force --default-branch main --description ${`Generated from ${SOURCE_REPO}/${EXAMPLE_PATH}`}`,
        { cwd: projectDir },
      ),
    );

    await exec(ws, sh`git push --force ${GIT_REMOTE} HEAD:main`, {
      cwd: projectDir,
      secretToRedact: created.credentialedRemote,
    });

    // `artifacts share` mints a read token and returns one
    // clone-ready URL, so there is nothing to hand-assemble. The URL
    // carries a live token — redact it from any error output.
    const shareLink = (
      await exec(ws, sh`artifacts share ${name} --scope read --ttl ${SHARE_TOKEN_TTL}`)
    ).trim();

    return Response.json({
      name,
      artifactRepo: created.name,
      remote: created.remote,
      branch: "main",
      projectDir,
      shareLink,
      cloneCommand: sh`git clone ${shareLink} ${name}`,
    } satisfies CreateResult);
  } catch (cause) {
    return errorJSON(cause, isAlreadyExists(cause) ? 409 : 500);
  } finally {
    ws[Symbol.dispose]?.();
  }
}

async function exec(
  ws: WorkspaceClient,
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

function errorJSON(error: unknown, status: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;
  return Response.json({ error: message, code }, { status });
}
