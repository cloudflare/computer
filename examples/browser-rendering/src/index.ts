import { DurableObject } from "cloudflare:workers";
import { type DurableObjectStorageLike, Workspace } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { puppeteer } from "@cloudflare/computer/plugins/puppeteer";
import browser from "@cloudflare/computer/shell/browser";
import { artifactResponseHeaders } from "./artifact-response.js";
import { authorizeDemoRequest } from "./demo-auth.js";
import {
  JAVASCRIPT_ENTRY,
  parseCommandResult,
  RUNS_DIRECTORY,
  shellCommand,
  TASK_DIRECTORY,
  TASK_PATH,
  TASK_SOURCE,
  TASK_TIMEOUT_MS,
} from "./execution-source.js";
import { retryableOnce } from "./retryable-once.js";
import { UI_HTML } from "./ui.js";

// The Worker Loader wires this loopback binding into the shell's
// Dynamic Worker so it can reach this Durable Object's Workspace.
export { WorkspaceServiceProxy } from "@cloudflare/computer";

interface Env {
  BrowserWorkspace: DurableObjectNamespace<BrowserWorkspace>;
  BROWSER: Fetcher;
  DEMO_TOKEN?: string;
  LOADER: WorkerLoader;
}

/** Which of the two invocation paths a run used. */
export type BrowserPath = "javascript" | "shell";

// Only the three files a run writes are readable through the artifact
// route, and only inside a run directory the task named.
const ARTIFACT_PATH = new RegExp(
  `^${RUNS_DIRECTORY}/[0-9a-f-]+/(?:report\\.md|page\\.json|screenshot\\.png)$`,
);

// The `browser` command dispatches to the JavaScript backend by its
// default id, so the two names have to line up.
const JAVASCRIPT_BACKEND = "worker-javascript";
const SHELL_BACKEND = "worker-shell";

interface BrowserRunRequest {
  path?: BrowserPath;
  url?: string;
}

interface BrowserArtifact {
  name: string;
  path: string;
  mediaType: string;
  bytes: number;
}

interface BrowserResultValue {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  title: string;
  description?: string | null;
  language?: string | null;
  summary?: string;
  outputDirectory?: string;
  reportPath?: string;
  dataPath?: string;
  screenshotPath?: string;
  sections?: Array<{ level: string; text: string }>;
  codeSamples?: Array<{ text: string }>;
  internalLinks?: Array<{ text: string; href: string }>;
  files?: BrowserArtifact[];
  document?: { elements: number; images: number; links: number; scripts: number };
}

interface BrowserRunResult {
  path: BrowserPath;
  invocation: string;
  exitCode: number;
  value: BrowserResultValue;
}

export class BrowserWorkspace extends DurableObject<Env> {
  readonly #workspace: Workspace;
  // Both paths import the same module. Keep a successful seed for this
  // instance, but let a later run retry if the write fails.
  readonly #seedTask = retryableOnce(async () => {
    await this.#workspace.fs.mkdir(TASK_DIRECTORY, { recursive: true });
    await this.#workspace.fs.writeFile(TASK_PATH, TASK_SOURCE);
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // These two registrations are the entire host-side integration.
    // The plugin puts Puppeteer in JavaScript executions; the command
    // group puts a `browser` command in the shell, which dispatches
    // back into the JavaScript backend below. The limits are this
    // example's own: a full-page screenshot crosses the capability
    // bridge encoded, so the defaults are too small for it.
    const javascript = new WorkerJavaScriptBackend({
      id: JAVASCRIPT_BACKEND,
      loader: env.LOADER,
      plugins: [puppeteer({ browser: env.BROWSER })],
      defaultTimeoutMs: 60_000,
      maxTimeoutMs: 90_000,
      maxConcurrentExecutions: 3,
      maxCapabilityBytes: 8 * 1024 * 1024,
      maxCapabilityRequestBytes: 16 * 1024 * 1024,
    });
    const shell = new WorkerShellBackend({
      id: SHELL_BACKEND,
      loader: env.LOADER,
      workspace: { binding: "BrowserWorkspace", id: ctx.id.toString() },
      ctx,
      commands: [browser],
    });
    this.#workspace = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends: [javascript, shell],
    });
  }

  // The shell's Dynamic Worker reaches this Workspace by id through
  // WorkspaceServiceProxy, which calls this method.
  async __getWorkspaceStub() {
    await this.#workspace.ready();
    return this.#workspace.stub();
  }

  async run(path: BrowserPath, target: string): Promise<BrowserRunResult> {
    const url = new URL(target);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("url must use http or https");
    }
    await this.#seedTask();

    const invocation = path === "shell" ? shellCommand(url.href) : JAVASCRIPT_ENTRY;
    using execution =
      path === "shell"
        ? await this.#workspace.runtime.exec(invocation, {
            backend: SHELL_BACKEND,
            cwd: TASK_DIRECTORY,
            encoding: "utf8",
            // The command applies TASK_TIMEOUT_MS to the browser work
            // itself, so the shell needs room for its own dispatch on
            // top of it.
            timeoutMs: TASK_TIMEOUT_MS + 30_000,
          })
        : await this.#workspace.runtime.exec(invocation, {
            backend: JAVASCRIPT_BACKEND,
            cwd: TASK_DIRECTORY,
            input: { url: url.href, hostname: url.hostname },
            encoding: "utf8",
            timeoutMs: TASK_TIMEOUT_MS,
          });

    const result = await execution.result();
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `browser run exited with ${result.exitCode}`);
    }
    // The JavaScript path returns the task's value as a structured
    // result. The shell path gets the same object, printed as JSON by
    // the command, because stdout is all a shell can carry.
    const value = path === "shell" ? parseCommandResult(result.stdout) : result.value;
    return { path, invocation, exitCode: result.exitCode, value: parseBrowserResult(value) };
  }

  readArtifact(path: string): Promise<ReadableStream<Uint8Array>> {
    if (!ARTIFACT_PATH.test(path)) throw new Error("invalid browser artifact path");
    return this.#workspace.fs.readFile(path);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const authorizationError = authorizeDemoRequest(request, env.DEMO_TOKEN);
    if (authorizationError) return authorizationError;
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/source") {
      return new Response(TASK_SOURCE, {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const stub = env.BrowserWorkspace.getByName("demo");
    if (request.method === "POST" && url.pathname === "/api/run") {
      let input: BrowserRunRequest;
      try {
        input = (await request.json()) as BrowserRunRequest;
        if (!isBrowserPath(input.path)) throw new Error("unknown browser path");
        if (typeof input.url !== "string") throw new Error("url must be a string");
      } catch (error) {
        return errorResponse(error, 400);
      }
      try {
        return Response.json(await stub.run(input.path, input.url));
      } catch (error) {
        return errorResponse(error, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/file") {
      const path = url.searchParams.get("path");
      if (path === null) return errorResponse(new Error("missing browser artifact path"), 400);
      try {
        const filename = path.slice(path.lastIndexOf("/") + 1);
        return new Response(await stub.readArtifact(path), {
          headers: artifactResponseHeaders(filename),
        });
      } catch (error) {
        return errorResponse(error, 404);
      }
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function parseBrowserResult(value: unknown): BrowserResultValue {
  if (!isRecord(value)) throw new Error("browser run returned an invalid result");
  const parsed: BrowserResultValue = {
    requestedUrl: requiredString(value.requestedUrl, "requestedUrl"),
    finalUrl: requiredString(value.finalUrl, "finalUrl"),
    title: requiredString(value.title, "title"),
    status: value.status === null ? null : requiredNumber(value.status, "status"),
  };
  if (typeof value.description === "string" || value.description === null) {
    parsed.description = value.description;
  }
  if (typeof value.language === "string" || value.language === null) {
    parsed.language = value.language;
  }
  if (typeof value.summary === "string") parsed.summary = value.summary;
  if (typeof value.outputDirectory === "string") parsed.outputDirectory = value.outputDirectory;
  if (typeof value.reportPath === "string") parsed.reportPath = value.reportPath;
  if (typeof value.dataPath === "string") parsed.dataPath = value.dataPath;
  if (typeof value.screenshotPath === "string") parsed.screenshotPath = value.screenshotPath;
  if (Array.isArray(value.sections)) {
    parsed.sections = value.sections.filter(isRecord).map((section) => ({
      level: requiredString(section.level, "section level"),
      text: requiredString(section.text, "section text"),
    }));
  }
  if (Array.isArray(value.codeSamples)) {
    parsed.codeSamples = value.codeSamples.filter(isRecord).map((sample) => ({
      text: requiredString(sample.text, "code sample"),
    }));
  }
  if (Array.isArray(value.internalLinks)) {
    parsed.internalLinks = value.internalLinks.filter(isRecord).map((link) => ({
      text: requiredString(link.text, "internal link text"),
      href: requiredString(link.href, "internal link href"),
    }));
  }
  if (Array.isArray(value.files)) {
    parsed.files = value.files.filter(isRecord).map((file) => ({
      name: requiredString(file.name, "artifact name"),
      path: requiredString(file.path, "artifact path"),
      mediaType: requiredString(file.mediaType, "artifact media type"),
      bytes: requiredNumber(file.bytes, "artifact size"),
    }));
  }
  if (isRecord(value.document)) {
    parsed.document = {
      elements: requiredNumber(value.document.elements, "element count"),
      images: requiredNumber(value.document.images, "image count"),
      links: requiredNumber(value.document.links, "link count"),
      scripts: requiredNumber(value.document.scripts, "script count"),
    };
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`browser result ${name} must be a string`);
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`browser result ${name} must be a finite number`);
  }
  return value;
}

function isBrowserPath(value: unknown): value is BrowserPath {
  return value === "javascript" || value === "shell";
}

function errorResponse(error: unknown, status: number): Response {
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}
