import type {
  ModuleExecutionEnvelope,
  ModuleExecutionInput,
  WorkspaceModuleBackend,
  WorkspaceModuleBackendHandle,
  WorkspaceModuleBackendHost,
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeLoader,
  WorkspaceRuntimeValue,
} from "@cloudflare/computer";

export const CELLD_JAVASCRIPT_BACKEND_ID = "celld-javascript";
const MOUNT_ROOT = "/workspace";

export interface CelldJavaScriptBackendOptions {
  id?: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  cpuMs?: number;
  globalOutbound?: null;
}

/**
 * A small Computer module backend that uses celld's experimental Worker Loader.
 *
 * The current celld Worker Loader supports fresh dynamic isolates, named
 * WorkerEntrypoint RPC, static sibling modules, plain JSON env, and no-egress
 * `globalOutbound: null`. That is enough for callable JavaScript execution.
 *
 * The full Computer WorkerJavaScriptBackend also passes a host filesystem bridge
 * into the loaded worker. celld v0.1.0 currently rejects that bridge with a
 * DataCloneError, so this backend deliberately exposes only the pieces that are
 * validated under celld today: structured input/output, captured console output,
 * `ctx.env`, `ctx.cwd`, `ctx.stdin`, and a descriptive `ctx.fs` placeholder.
 */
export class CelldJavaScriptBackend implements WorkspaceModuleBackend {
  readonly protocol = "module" as const;
  readonly type = "celld-javascript";
  readonly callable = true;
  readonly id: string;

  readonly compatibilityDate: string;
  readonly compatibilityFlags: string[];
  readonly cpuMs: number;
  readonly globalOutbound: null;

  constructor(
    private readonly loader: WorkspaceRuntimeLoader,
    options: CelldJavaScriptBackendOptions = {},
  ) {
    this.id = options.id ?? CELLD_JAVASCRIPT_BACKEND_ID;
    this.compatibilityDate = options.compatibilityDate ?? "2026-05-26";
    this.compatibilityFlags = options.compatibilityFlags ?? ["nodejs_compat", "js_rpc"];
    this.cpuMs = options.cpuMs ?? 30_000;
    this.globalOutbound = options.globalOutbound ?? null;
  }

  async connect(_host: WorkspaceModuleBackendHost): Promise<WorkspaceModuleBackendHandle> {
    return new CelldJavaScriptBackendHandle(this.loader, {
      id: this.id,
      compatibilityDate: this.compatibilityDate,
      compatibilityFlags: this.compatibilityFlags,
      cpuMs: this.cpuMs,
      globalOutbound: this.globalOutbound,
    });
  }
}

class CelldJavaScriptBackendHandle implements WorkspaceModuleBackendHandle {
  private readonly records = new Map<string, WorkspaceRuntimeEvent[]>();

  constructor(
    private readonly loader: WorkspaceRuntimeLoader,
    private readonly options: Required<CelldJavaScriptBackendOptions> & { id: string },
  ) {}

  async exec(input: ModuleExecutionInput): Promise<ModuleExecutionEnvelope> {
    const id = input.id ?? crypto.randomUUID();
    const events = await this.run(id, input);
    this.records.set(id, events);
    return { id, events: streamEvents(events) };
  }

  async getExec(input: { id: string; after?: number | "tail" }): Promise<ModuleExecutionEnvelope> {
    const events = this.records.get(input.id);
    if (!events)
      throw Object.assign(new Error(`no such execution: ${input.id}`), { code: "ENOENT" });
    const after = input.after === "tail" ? Math.max(0, events.length - 1) : (input.after ?? 0);
    return { id: input.id, events: streamEvents(events.filter((event) => event.seq > after)) };
  }

  async killExec(_input: { id: string }): Promise<void> {
    throw new Error(
      `${this.options.id} executions are synchronous and cannot be killed after admission.`,
    );
  }

  async disposeExec(input: { id: string }): Promise<void> {
    this.records.delete(input.id);
  }

  async close(): Promise<void> {
    this.records.clear();
  }

  private async run(id: string, input: ModuleExecutionInput): Promise<WorkspaceRuntimeEvent[]> {
    try {
      const timeoutMs = input.timeoutMs ?? this.options.cpuMs;
      const worker = this.loader.load({
        compatibilityDate: this.options.compatibilityDate,
        compatibilityFlags: this.options.compatibilityFlags,
        limits: { cpuMs: timeoutMs },
        mainModule: "runner.js",
        modules: {
          "entry.js": input.source,
          "runner.js": celldJavaScriptRunner(),
        },
        globalOutbound: this.options.globalOutbound,
      });

      const entrypoint = worker.getEntrypoint("Runner", {
        limits: { cpuMs: timeoutMs },
      }) as {
        evaluate(input: WorkspaceRuntimeValue, meta: CelldRunnerMeta): Promise<CelldRunnerResult>;
      };

      const meta: CelldRunnerMeta = {
        env: input.env ?? {},
        cwd: normalizePath(input.cwd ?? MOUNT_ROOT),
        stdin: typeof input.stdin === "string" ? input.stdin : decodeBytes(input.stdin),
      };
      const result = await entrypoint.evaluate(input.input ?? null, meta);

      const events: WorkspaceRuntimeEvent[] = [];
      if (result.stdout)
        events.push({ id, seq: events.length + 1, name: "stdout", value: encode(result.stdout) });
      if (result.stderr)
        events.push({ id, seq: events.length + 1, name: "stderr", value: encode(result.stderr) });
      events.push({
        id,
        seq: events.length + 1,
        name: "exit",
        code: 0,
        result: result.value ?? null,
      });
      return events;
    } catch (error) {
      return [
        {
          id,
          seq: 1,
          name: "stderr",
          value: encode(
            `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
          ),
        },
        { id, seq: 2, name: "exit", code: 1 },
      ];
    }
  }
}

interface CelldRunnerMeta {
  env: Record<string, string>;
  cwd: string;
  stdin: string;
}

interface CelldRunnerResult {
  value: WorkspaceRuntimeValue;
  stdout: string;
  stderr: string;
}

function celldJavaScriptRunner(): string {
  return `
    import { WorkerEntrypoint } from "cloudflare:workers";
    import * as userModule from "entry.js";

    export class Runner extends WorkerEntrypoint {
      async evaluate(input, meta) {
        const stdout = [];
        const stderr = [];
        const write = (target, args) => target.push(args.map(formatConsoleValue).join(" ") + "\\n");
        console.log = (...args) => write(stdout, args);
        console.info = (...args) => write(stdout, args);
        console.warn = (...args) => write(stderr, args);
        console.error = (...args) => write(stderr, args);

        const ctx = {
          env: meta.env || {},
          cwd: meta.cwd || "/workspace",
          stdin: meta.stdin || "",
          fs: unsupportedFs(),
        };

        globalThis.process = {
          env: ctx.env,
          argv: ["workspace", "entry.js"],
          cwd: () => ctx.cwd,
          platform: "linux",
          stdin: ctx.stdin,
          stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
          stderr: { write: (chunk) => { stderr.push(String(chunk)); return true; } },
        };
        globalThis.ctx = ctx;

        const result = typeof userModule.default === "function"
          ? await userModule.default(input, ctx)
          : userModule.default;
        return { value: result ?? null, stdout: stdout.join(""), stderr: stderr.join("") };
      }
    }

    function unsupportedFs() {
      const fail = () => {
        throw new Error(
          "ctx.fs is not wired yet: celld Worker Loader does not currently clone " +
          "the host filesystem capability into loaded workers. Use the read, " +
          "write, edit, ls, find, grep, and delete tools outside exec."
        );
      };
      return {
        readFile: fail,
        writeFile: fail,
        readdir: fail,
        mkdir: fail,
        rm: fail,
        stat: fail,
        exists: fail,
        ls: fail,
        find: fail,
        grep: fail,
      };
    }

    function formatConsoleValue(value) {
      if (typeof value === "string") return value;
      try { return JSON.stringify(value); } catch { return String(value); }
    }

    export default {
      fetch() {
        return new Response("ok");
      }
    };
  `;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..")
      throw Object.assign(new Error(`path escapes ${MOUNT_ROOT}: ${path}`), { code: "EINVAL" });
    parts.push(part);
  }
  const absolute = `/${parts.join("/")}`;
  if (absolute !== MOUNT_ROOT && !absolute.startsWith(`${MOUNT_ROOT}/`)) {
    throw Object.assign(new Error(`path must sit under ${MOUNT_ROOT}: ${path}`), {
      code: "EINVAL",
    });
  }
  return absolute;
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeBytes(value: Uint8Array | string | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function streamEvents(events: WorkspaceRuntimeEvent[]): ReadableStream<WorkspaceRuntimeEvent> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
}
