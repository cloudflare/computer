import { WorkspaceRuntimeBridge } from "../../runtime/bridge.js";
import { assertRuntimeValue, WorkspaceRuntimeCapability } from "../../runtime/capability.js";
import { dynamicWorkerEgress } from "../../runtime/egress.js";
import type {
  WorkspaceModuleBackend,
  WorkspaceModuleBackendHandle,
  WorkspaceModuleBackendHost,
  WorkspaceModuleCallContext,
  WorkspaceModuleFunctions,
  WorkspaceRuntimeValue,
} from "../../runtime/types.js";
import { buildModuleGraph, hasNodeModules } from "../worker-javascript/module-graph.js";
import {
  assertLoaderGraph,
  describeJavaScriptBackend,
  JavaScriptBackendHandle,
  type JavaScriptBackendConnection,
  type ResolvedWorkerJavaScriptBackendOptions,
  resolveJavaScriptBackendOptions,
  runtimeError,
  type WorkerJavaScriptBackendOptions,
} from "../worker-javascript/worker-javascript.js";
import {
  APP_CLASS,
  APP_MODULE,
  APPS_SPECIFIER,
  appMainModule,
  appStandInModule,
  DISPATCH_METHOD,
  durableObjectClassName,
  facetsModule,
  FACETS_MODULE,
} from "./app-modules.js";

/**
 * The Worker Loader binding, as the backend uses it. It loads each app
 * as a Dynamic Worker and runs its Durable Object class as a facet.
 */
export interface DynamicJavaScriptLoader {
  load(code: {
    compatibilityDate: string;
    compatibilityFlags?: string[];
    limits?: { cpuMs?: number };
    mainModule: string;
    modules: Record<string, string | { js?: string }>;
    env?: Record<string, unknown>;
    globalOutbound?: Fetcher | null;
  }): {
    getEntrypoint(name?: string, options?: { limits?: { cpuMs?: number } }): unknown;
    getDurableObjectClass(
      name?: string,
      options?: { limits?: { cpuMs?: number } },
    ): DurableObjectClass;
  };
}

/**
 * The host Durable Object's `ctx.facets`. Each app instance runs as one
 * facet of it, with its own SQLite storage.
 */
export interface DynamicJavaScriptFacets {
  get(name: string, getStartupOptions: () => { class: DurableObjectClass }): unknown;
  abort(name: string, reason: unknown): void;
  delete(name: string): void;
  clone(source: string, destination: string): void;
}

export interface DynamicJavaScriptBackendOptions extends Omit<
  WorkerJavaScriptBackendOptions,
  "loader"
> {
  /** The Worker Loader binding, such as `env.LOADER`. */
  loader: DynamicJavaScriptLoader;
  /** The host Durable Object's `ctx.facets`. */
  facets: DynamicJavaScriptFacets;
}

// Facet names are capped at 256 characters, and an instance name is part
// of one, hashed, so this only bounds what crosses the bridge.
const MAX_INSTANCE_NAME_BYTES = 1024;

const APPS_DESCRIPTION = [
  "A workspace file whose default export is a class that extends `DurableObject` from `cloudflare:workers` is an app: it runs in its own long-lived Durable Object, with its own storage in `this.ctx.storage` (`sql` and `kv`). `node:fs` and the modules below work inside its methods.",
  "Importing an app gives `ctx.facets` for that app, a `DurableObjectFacets` with one facet per instance name. `const counter = Counter.get(\"main\")` returns the instance with that name, and `await counter.increment(1)` runs the method in it. `Counter.abort(name, reason)` restarts an instance and keeps its storage, `Counter.delete(name)` deletes it with its storage, and `Counter.clone(source, destination)` replaces one instance's storage with a copy of another's. Editing the file restarts its instances on their next call.",
  "Arguments and results must be JSON-compatible. Keep anything that must last in storage, not in fields: an instance can restart at any time.",
].join("\n");

/**
 * Runs ECMAScript modules like `WorkerJavaScriptBackend`, and runs
 * Workspace files that export a Durable Object class as long-lived apps.
 *
 * Code imports an app's file and calls methods on an instance of it:
 *
 * ```js
 * import Counter from "./counter.js";
 *
 * export default async function () {
 *   const counter = Counter.get("main");
 *   return counter.increment(1);
 * }
 * ```
 *
 * Each instance runs as a facet of the host Durable Object, with its own
 * SQLite storage, and keeps running between executions.
 *
 * Experimental.
 */
export class DynamicJavaScriptBackend implements WorkspaceModuleBackend {
  readonly protocol = "module" as const;
  readonly type = "dynamic-javascript";
  readonly callable = true;
  readonly id: string;
  readonly #options: ResolvedWorkerJavaScriptBackendOptions;
  readonly #loader: DynamicJavaScriptLoader;
  readonly #facets: DynamicJavaScriptFacets;

  constructor(options: DynamicJavaScriptBackendOptions) {
    const { facets, ...rest } = options;
    if (facets === undefined || facets === null) {
      throw new Error(
        "DynamicJavaScriptBackend needs facets, the host Durable Object's ctx.facets.",
      );
    }
    this.#options = resolveJavaScriptBackendOptions(
      rest,
      "DynamicJavaScriptBackend",
      "dynamic-javascript",
    );
    this.id = this.#options.id ?? "dynamic-javascript";
    this.#loader = options.loader;
    this.#facets = facets;
  }

  /** What this backend tells a model: the source language, apps, and every importable module. */
  get description(): string {
    return describeJavaScriptBackend(this.#options, [APPS_DESCRIPTION]);
  }

  async connect(host: WorkspaceModuleBackendHost): Promise<WorkspaceModuleBackendHandle> {
    return new JavaScriptBackendHandle(this.#options, host, (connection) => {
      const apps = new AppInstances({
        options: this.#options,
        loader: this.#loader,
        facets: this.#facets,
        host,
        connection,
      });
      return {
        bridgeModules: new Map([[APPS_SPECIFIER, apps.functions]]),
        internalModules: { [FACETS_MODULE]: facetsModule() },
        replaceModule(path, source, internalImport) {
          const className = durableObjectClassName(source);
          if (className === undefined) return undefined;
          return appStandInModule(path, className, internalImport(FACETS_MODULE));
        },
      };
    });
  }
}

interface AppFacet {
  [DISPATCH_METHOD](
    method: string,
    args: WorkspaceRuntimeValue[],
    host: WorkspaceRuntimeBridge,
  ): Promise<{ result: WorkspaceRuntimeValue } | { error: { message: string } }>;
}

// Runs app instances as facets: loads each app's code, restarts an
// instance when its code changes, and runs one call at a time per
// instance.
class AppInstances {
  readonly functions: WorkspaceModuleFunctions;
  readonly #options: ResolvedWorkerJavaScriptBackendOptions;
  readonly #loader: DynamicJavaScriptLoader;
  readonly #facets: DynamicJavaScriptFacets;
  readonly #host: WorkspaceModuleBackendHost;
  readonly #connection: JavaScriptBackendConnection;
  // The hash of the code each running facet loaded. A facet missing here
  // may still be running code from before this object existed, such as
  // after the host restarted, so its first call restarts it.
  readonly #loaded = new Map<string, string>();
  // The last call queued for each facet. Each call waits for the one
  // before it to settle, so an instance runs one call at a time.
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(input: {
    options: ResolvedWorkerJavaScriptBackendOptions;
    loader: DynamicJavaScriptLoader;
    facets: DynamicJavaScriptFacets;
    host: WorkspaceModuleBackendHost;
    connection: JavaScriptBackendConnection;
  }) {
    this.#options = input.options;
    this.#loader = input.loader;
    this.#facets = input.facets;
    this.#host = input.host;
    this.#connection = input.connection;
    this.functions = {
      call: (args, context) => this.#call(args, context),
      abort: (args, context) => this.#abort(args, context),
      delete: (args, context) => this.#delete(args, context),
      clone: (args, context) => this.#clone(args, context),
    };
  }

  async #call(args: readonly WorkspaceRuntimeValue[], context: WorkspaceModuleCallContext) {
    this.#assertWritable(context);
    const [path, name, method, methodArgs] = args;
    if (typeof method !== "string" || !Array.isArray(methodArgs)) {
      throw new TypeError("An app call takes a method name and an argument list.");
    }
    const { resolved, facet } = await this.#target(path, name, context, false);
    const run = this.#queued(facet).then(() =>
      this.#run(resolved, facet, method, methodArgs, context),
    );
    this.#enqueue(facet, run);
    return untilAborted(run, context.signal);
  }

  // Settles once every call queued on the facet so far has settled.
  #queued(facet: string): Promise<unknown> {
    return this.#queues.get(facet) ?? Promise.resolve();
  }

  // Make later calls to the facet wait for `run`. The queue moves on when
  // the call settles, not when its caller stops waiting: a method that
  // never returns holds the instance until `abort` restarts it.
  #enqueue(facet: string, run: Promise<unknown>) {
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(facet, settled);
    void settled.then(() => {
      if (this.#queues.get(facet) === settled) this.#queues.delete(facet);
    });
  }

  async #abort(args: readonly WorkspaceRuntimeValue[], context: WorkspaceModuleCallContext) {
    this.#assertWritable(context);
    const [path, name, reason] = args;
    const { facet } = await this.#target(path, name, context, true);
    this.#facets.abort(
      facet,
      new Error(typeof reason === "string" ? reason : "The app instance was aborted."),
    );
    this.#loaded.delete(facet);
    return null;
  }

  async #delete(args: readonly WorkspaceRuntimeValue[], context: WorkspaceModuleCallContext) {
    this.#assertWritable(context);
    const [path, name] = args;
    const { facet } = await this.#target(path, name, context, true);
    this.#facets.delete(facet);
    this.#loaded.delete(facet);
    return null;
  }

  // Copy one instance's storage over another's, as ctx.facets.clone does.
  // It waits for calls already queued on both instances, and later calls
  // to either wait for it.
  async #clone(args: readonly WorkspaceRuntimeValue[], context: WorkspaceModuleCallContext) {
    this.#assertWritable(context);
    const [path, source, destination] = args;
    const from = await this.#target(path, source, context, false);
    const to = await this.#target(path, destination, context, false);
    if (from.facet === to.facet) {
      throw new TypeError("An app instance can't be cloned onto itself.");
    }
    const run = Promise.all([this.#queued(from.facet), this.#queued(to.facet)]).then(() => {
      if (context.signal.aborted) throw context.signal.reason;
      this.#facets.clone(from.facet, to.facet);
      // The destination now holds another instance's storage, so its
      // next call starts it afresh.
      this.#loaded.delete(to.facet);
      return null;
    });
    this.#enqueue(from.facet, run);
    this.#enqueue(to.facet, run);
    return untilAborted(run, context.signal);
  }

  // Calling an app can write its storage, so a read-only backend refuses
  // every app call.
  #assertWritable(context: WorkspaceModuleCallContext) {
    if (context.access !== "read-write") {
      throw runtimeError("EACCES", "Apps can't be called on a read-only backend.");
    }
  }

  async #target(
    path: WorkspaceRuntimeValue | undefined,
    name: WorkspaceRuntimeValue | undefined,
    context: WorkspaceModuleCallContext,
    allowMissing: boolean,
  ) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new TypeError("An app call takes the app's absolute path.");
    }
    if (typeof name !== "string" || name === "") {
      throw new TypeError("An app instance's name must be a non-empty string.");
    }
    if (new TextEncoder().encode(name).byteLength > MAX_INSTANCE_NAME_BYTES) {
      throw new TypeError(
        `An app instance's name must be at most ${MAX_INSTANCE_NAME_BYTES} bytes.`,
      );
    }
    const resolved = await context.resolvePath(path, { allowMissing });
    const facet = `${this.#options.id}:${await sha256(JSON.stringify([resolved, name]))}`;
    return { resolved, facet };
  }

  async #run(
    path: string,
    facet: string,
    method: string,
    args: WorkspaceRuntimeValue[],
    context: WorkspaceModuleCallContext,
  ): Promise<WorkspaceRuntimeValue> {
    if (context.signal.aborted) throw context.signal.reason;
    const capability = new WorkspaceRuntimeCapability(
      this.#host.fs,
      this.#options.root,
      this.#options.access,
      this.#options.maxCapabilityBytes,
      this.#options.maxDirectoryEntries,
    );
    const source = await capability.readFile(path);
    if (durableObjectClassName(source) === undefined) {
      throw new TypeError(
        `${path} is not an app: its default export must be a class that extends DurableObject from cloudflare:workers.`,
      );
    }
    const slash = path.lastIndexOf("/");
    const graph = await buildModuleGraph({
      source: `export { default } from ${JSON.stringify(`./${path.slice(slash + 1)}`)};`,
      cwd: path.slice(0, slash) || "/",
      capability,
      configuredModules: this.#connection.sourceModules(),
      hostModules: this.#connection.hostModules,
      emptyHostModules: this.#connection.emptyHostModules,
      nodeModules: hasNodeModules(this.#options.compatibilityFlags),
      runtimeModules: ["cloudflare:workers"],
      maxSourceBytes: this.#options.maxSourceBytes,
      maxCapabilityBytes: this.#options.maxCapabilityBytes,
    });
    const modules = { ...graph.modules, [APP_MODULE]: appMainModule(graph.entryName) };
    assertLoaderGraph(modules, this.#options.maxSourceBytes);
    const hash = await sha256(JSON.stringify(Object.entries(modules).sort(byKey)));
    if (this.#loaded.get(facet) !== hash) {
      // Aborting a facet that isn't running does nothing, so this is safe
      // when the instance has never started.
      this.#facets.abort(facet, new Error("The app's code changed, so its instance restarted."));
      this.#loaded.set(facet, hash);
    }
    // SAFETY: A facet stub forwards method calls to the class the startup
    // options name, and that class is APP_CLASS from appMainModule, which
    // defines the dispatcher.
    const stub = this.#facets.get(facet, () => ({
      class: this.#loader
        .load({
          compatibilityDate: this.#options.compatibilityDate,
          compatibilityFlags: this.#options.compatibilityFlags,
          mainModule: APP_MODULE,
          modules,
          env: {},
          ...dynamicWorkerEgress(this.#options.egress),
        })
        .getDurableObjectClass(APP_CLASS, { limits: { cpuMs: this.#options.maxCpuMs } }),
    })) as AppFacet;
    const bridge = new WorkspaceRuntimeBridge(capability, {
      hostModules: this.#connection.hostModules,
      maxPayloadBytes: this.#options.maxCapabilityBytes,
      maxCallDurationMs: this.#options.maxHostCallMs,
      maxConcurrentCalls: this.#options.maxConcurrentCapabilityCalls,
      maxCalls: this.#options.maxCapabilityCalls,
      maxTotalRequestBytes: this.#options.maxCapabilityRequestBytes,
      maxTotalResponseBytes: this.#options.maxCapabilityResponseBytes,
      maxResultBytes: this.#options.maxResultBytes,
    });
    // When the caller stops waiting, the app can't reach the Workspace
    // through this call any more.
    const cancel = () => void bridge.cancelAndDrain().catch(() => undefined);
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      const response = await stub[DISPATCH_METHOD](method, args, bridge);
      if ("error" in response) throw new Error(response.error.message);
      assertRuntimeValue(response.result);
      return response.result;
    } finally {
      context.signal.removeEventListener("abort", cancel);
      // Wait for Workspace calls the method started and didn't await, so
      // none lands after the call returns. Later ones are refused.
      await bridge.cancelAndDrain().catch(() => undefined);
    }
  }
}

// Stop waiting when the caller's call passes its deadline or its
// execution is cancelled. The call itself keeps going.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function byKey([a]: [string, unknown], [b]: [string, unknown]) {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
