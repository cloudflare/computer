import { assertHostModuleExports } from "./export-names";
import type {
  WorkspaceModuleExecution,
  WorkspaceModuleFunction,
  WorkspaceModuleFunctions,
  WorkspaceModuleHost,
} from "./types";

declare const codemodeModuleBrand: unique symbol;

// Registered symbols, so two copies of this package agree on them, and
// symbols, so they can't collide with a method or export name.
const CODEMODE_MODULE = Symbol.for("@cloudflare/computer/codemode-module");
const DEFINITION = Symbol.for("@cloudflare/computer/codemode-module-definition");
const OBJECT = Symbol.for("@cloudflare/computer/codemode-object");

// Names every host call's ctx already uses, so a context can't take them.
const RESERVED_CONTEXT_NAMES = new Set([
  "callId",
  "signal",
  "deadline",
  "execution",
  "interrupt",
  "access",
  "resolvePath",
]);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** How a scope, or an object in it, ended, as a disposer is told. */
export type WorkspaceModuleScopeEnd =
  | {
      /**
       * The run is waiting in `ctx.interrupt()` and has released its
       * isolate. Its code starts again from the top when it resumes, in
       * a new scope.
       */
      readonly reason: "paused";
      /** Aborts at `deadline`, when the backend stops waiting. */
      readonly signal: AbortSignal;
      /** Epoch milliseconds after which the backend stops waiting. */
      readonly deadline: number;
    }
  | {
      /** Program code released the object early, with `using` or `Symbol.dispose`. */
      readonly reason: "disposed";
      readonly signal: AbortSignal;
      readonly deadline: number;
    }
  | {
      /** How the run ended. */
      readonly reason: "completed" | "failed" | "cancelled";
      readonly signal: AbortSignal;
      readonly deadline: number;
      /**
       * Append text to the run's stderr, before its exit. Text past what
       * is left of the run's output limit is cut, and ends with a line
       * saying so. Anything logged after the disposer returns is dropped.
       */
      log(text: string): void;
    };

/**
 * One scope of a run: from when its code starts in an isolate until it
 * waits in `ctx.interrupt()` or ends. A run that resumes starts a new
 * scope with the same `id`.
 */
export interface WorkspaceModuleScope extends WorkspaceModuleExecution {
  /** Aborts when the scope is cancelled or its isolate is released. */
  readonly signal: AbortSignal;
}

/** The methods of an object a codemode module defines. Each is called as `(args, ctx)`. */
export type CodemodeObjectMethods = Readonly<Record<string, WorkspaceModuleFunction>>;

/**
 * Builds one kind of object from its state. Call it to make an object;
 * after a restart the backend calls the same builder with the saved
 * state to get the object back.
 */
export interface CodemodeObjectConstructor<State, Methods extends CodemodeObjectMethods> {
  (state: State): Methods;
  /** The kind's name, as the journal records it. */
  readonly kind: string;
}

/**
 * How a scope ended, as a scoped context's `dispose` is told. Only
 * objects can be released early, so a context never gets "disposed".
 */
export type CodemodeContextScopeEnd = Exclude<
  WorkspaceModuleScopeEnd,
  { readonly reason: "disposed" }
>;

/** Options for a context that lives for one scope of a run. */
export interface CodemodeScopedContextOptions<Value> {
  readonly scoped: true;
  /**
   * Let go of the value when the scope ends, or when the run pauses.
   * Called only if the value was started. Without it, the value's own
   * `Symbol.asyncDispose` or `Symbol.dispose` is used, if it has one.
   */
  dispose?(value: Value, end: CodemodeContextScopeEnd): void | Promise<void>;
}

/** What `createCodemodeModule()` takes. */
export interface CodemodeModuleOptions {
  /** What the module does and how to call it, for a model. */
  readonly description?: string;
  /**
   * A name for the builder. Only needed to make more than one module
   * from the same builder.
   */
  readonly name?: string;
}

/** Defines a codemode module's objects and context, then makes the module. */
export interface CodemodeModuleBuilder {
  /**
   * Define a kind of object the module can return. The builder makes an
   * object of methods from its state. The state must be JSON, and must
   * be enough to make the object again.
   */
  define<State, Methods extends CodemodeObjectMethods>(
    kind: string,
    build: (state: State) => Methods,
  ): CodemodeObjectConstructor<State, Methods>;
  /**
   * Add `ctx[name]`, made once when the backend connects, from the
   * Workspace's services. Use it for clients and config.
   */
  context<Value>(name: string, create: (host: WorkspaceModuleHost) => Value): CodemodeModuleBuilder;
  /**
   * Add `ctx[name]`, made once for each scope of a run, the first time a
   * method reads it. `ctx[name]` is then a promise of the value.
   */
  context<Value>(
    name: string,
    create: (scope: WorkspaceModuleScope, host: WorkspaceModuleHost) => Value | Promise<Value>,
    options: CodemodeScopedContextOptions<Value>,
  ): CodemodeModuleBuilder;
  /** Make the module from its exported functions. */
  module(functions: WorkspaceModuleFunctions): CodemodeModule;
}

/** A host module made by `createCodemodeModule()`. */
export interface CodemodeModule {
  readonly description?: string;
  /** The names code can import. */
  readonly exports: readonly string[];
  readonly [codemodeModuleBrand]: true;
}

/** One context a codemode module adds to `ctx`. */
export interface CodemodeContextDefinition {
  readonly name: string;
  readonly create: (...args: never[]) => unknown;
  readonly scoped: boolean;
  readonly dispose?: (value: never, end: CodemodeContextScopeEnd) => void | Promise<void>;
}

/** Everything the backend needs from a codemode module. */
export interface CodemodeModuleDefinition {
  /** Identifies the builder, so objects from another module are refused. */
  readonly owner: object;
  readonly functions: WorkspaceModuleFunctions;
  readonly kinds: ReadonlyMap<string, (state: unknown) => CodemodeObjectMethods>;
  readonly contexts: readonly CodemodeContextDefinition[];
}

/** What a defined object remembers about itself. */
export interface CodemodeObjectInfo {
  readonly owner: object;
  readonly kind: string;
  readonly state: unknown;
}

/**
 * Start a codemode module: a host module that can return objects with
 * methods, and give its functions shared context. Objects keep working
 * after a pause or a deploy, because the backend journals their state
 * and rebuilds them from it. Experimental: it may change in any release.
 *
 * ```ts
 * const jobs = createCodemodeModule({ description: "Build jobs." });
 * const Run = jobs.define("Run", ({ id }) => ({
 *   wait: async (_args, ctx) => api.wait(id, { signal: ctx.signal }),
 * }));
 * modules: {
 *   "codemode:jobs": jobs.module({
 *     start: async ([ref], ctx) => Run({ id: await api.start(ref, { key: ctx.callId }) }),
 *   }),
 * }
 * ```
 */
export function createCodemodeModule(options: CodemodeModuleOptions = {}): CodemodeModuleBuilder {
  const owner = Object.freeze({ name: options.name });
  const kinds = new Map<string, (state: unknown) => CodemodeObjectMethods>();
  const contexts: CodemodeContextDefinition[] = [];
  let made = false;

  const builder: CodemodeModuleBuilder = {
    define<State, Methods extends CodemodeObjectMethods>(
      kind: string,
      build: (state: State) => Methods,
    ) {
      if (typeof kind !== "string" || kind === "" || kind.includes("#") || kind.includes(".")) {
        throw new Error('A codemode object kind must be a non-empty string without "#" or ".".');
      }
      if (typeof build !== "function") {
        throw new Error(`Codemode object kind ${JSON.stringify(kind)} needs a builder function.`);
      }
      if (kinds.has(kind)) {
        throw new Error(`This codemode module already defines ${JSON.stringify(kind)}.`);
      }
      const make = (state: State): Methods => {
        const built: unknown = build(state);
        if (typeof built !== "object" || built === null) {
          throw new Error(
            `Codemode object kind ${JSON.stringify(kind)}'s builder must return an object of methods.`,
          );
        }
        Object.defineProperty(built, OBJECT, {
          value: Object.freeze({ owner, kind, state }),
        });
        return built as Methods;
      };
      kinds.set(kind, make as (state: unknown) => CodemodeObjectMethods);
      return Object.assign(make, { kind }) as CodemodeObjectConstructor<State, Methods>;
    },

    context(
      name: string,
      create: (...args: never[]) => unknown,
      contextOptions?: CodemodeScopedContextOptions<unknown>,
    ) {
      if (typeof name !== "string" || !IDENTIFIER.test(name)) {
        throw new Error(
          `A codemode context name must be a JavaScript identifier, not ${JSON.stringify(name)}.`,
        );
      }
      if (RESERVED_CONTEXT_NAMES.has(name)) {
        throw new Error(`The codemode context name ${JSON.stringify(name)} is reserved by ctx.`);
      }
      if (contexts.some((context) => context.name === name)) {
        throw new Error(
          `This codemode module already has a context named ${JSON.stringify(name)}.`,
        );
      }
      if (typeof create !== "function") {
        throw new Error(`Codemode context ${JSON.stringify(name)} needs a function to create it.`);
      }
      contexts.push(
        Object.freeze({
          name,
          create,
          scoped: contextOptions?.scoped === true,
          dispose: contextOptions?.dispose as CodemodeContextDefinition["dispose"],
        }),
      );
      return builder;
    },

    module(functions: WorkspaceModuleFunctions) {
      if (made && options.name === undefined) {
        throw new Error(
          "This codemode module builder already made its module. Give the builder a name to make another.",
        );
      }
      assertHostModuleExports(options.name ?? "createCodemodeModule()", functions);
      made = true;
      const definition: CodemodeModuleDefinition = Object.freeze({
        owner,
        functions: Object.freeze({ ...functions }),
        kinds,
        contexts,
      });
      const module = {
        ...(options.description === undefined ? {} : { description: options.description }),
        exports: Object.freeze(Object.keys(functions)),
        [CODEMODE_MODULE]: true,
      };
      Object.defineProperty(module, DEFINITION, { value: definition });
      // SAFETY: The symbol written above is the brand the type names.
      return Object.freeze(module) as unknown as CodemodeModule;
    },
  };
  return builder;
}

/** Whether a value is a module `createCodemodeModule()` made. */
export function isCodemodeModule(module: unknown): module is CodemodeModule {
  return (
    typeof module === "object" &&
    module !== null &&
    (module as { [CODEMODE_MODULE]?: unknown })[CODEMODE_MODULE] === true &&
    (module as { [DEFINITION]?: unknown })[DEFINITION] !== undefined
  );
}

/** A codemode module's definition, for the backend. */
export function codemodeModuleDefinition(module: unknown): CodemodeModuleDefinition | undefined {
  return isCodemodeModule(module)
    ? (module as unknown as { [DEFINITION]: CodemodeModuleDefinition })[DEFINITION]
    : undefined;
}

/** What a defined object remembers about itself, or undefined for anything else. */
export function codemodeObjectInfo(value: unknown): CodemodeObjectInfo | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null)
    return undefined;
  const info = (value as { [OBJECT]?: CodemodeObjectInfo })[OBJECT];
  return info === undefined ? undefined : info;
}
